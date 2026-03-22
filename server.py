import calendar
import hashlib
import hmac
import json
import os
import secrets
from datetime import date, datetime
from functools import lru_cache
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from time import time

try:
    import boto3
except ImportError:  # pragma: no cover - surfaced in API response
    boto3 = None

try:
    from botocore.exceptions import ClientError
except ImportError:  # pragma: no cover - surfaced in API response
    ClientError = Exception


ROOT = Path(__file__).resolve().parent
INFRA_OPS_DATA_PATH = ROOT / "data" / "infra-ops-data.json"


def load_env_file(path: Path):
    if not path.exists():
        return

    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


load_env_file(ROOT / ".env")


def read_json_file(path: Path):
    return json.loads(path.read_text())


def write_json_file(path: Path, payload: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")

PORT = int(os.getenv("PORT", "8000"))
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
AWS_PROFILE = os.getenv("AWS_PROFILE")
AWS_COST_METRIC = os.getenv("AWS_COST_METRIC", "UnblendedCost")
AWS_COST_TAG_KEY = os.getenv("AWS_COST_TAG_KEY", "Environment")
AWS_MONTHLY_BUDGET = os.getenv("AWS_MONTHLY_BUDGET")
AWS_UNIT_COUNT = os.getenv("AWS_UNIT_COUNT")
AWS_UNIT_COUNT_PREVIOUS = os.getenv("AWS_UNIT_COUNT_PREVIOUS")
AUTH_USERNAME = os.getenv("AUTH_USERNAME")
AUTH_PASSWORD = os.getenv("AUTH_PASSWORD")
SESSION_SECRET = os.getenv("SESSION_SECRET", "change-me-in-production")
SESSION_COOKIE_NAME = "infraops_session"
SESSION_DURATION_SECONDS = 60 * 60 * 12
AUTH_ENABLED = bool(AUTH_USERNAME and AUTH_PASSWORD)
SESSIONS = {}
FORECAST_METRIC_MAP = {
    "BlendedCost": "BLENDED_COST",
    "UnblendedCost": "UNBLENDED_COST",
    "AmortizedCost": "AMORTIZED_COST",
    "NetUnblendedCost": "NET_UNBLENDED_COST",
    "NetAmortizedCost": "NET_AMORTIZED_COST",
}


def month_start(day: date) -> date:
    return day.replace(day=1)


def next_month_start(day: date) -> date:
    year = day.year + (1 if day.month == 12 else 0)
    month = 1 if day.month == 12 else day.month + 1
    return date(year, month, 1)


def shift_months(day: date, months: int) -> date:
    month_index = day.month - 1 + months
    year = day.year + month_index // 12
    month = month_index % 12 + 1
    day_value = min(day.day, calendar.monthrange(year, month)[1])
    return date(year, month, day_value)


def parse_amount(results_by_time) -> float:
    if not results_by_time:
        return 0.0
    amount = results_by_time[0]["Total"][AWS_COST_METRIC]["Amount"]
    return round(float(amount), 2)


def parse_group_amount(group) -> float:
    return round(float(group["Metrics"][AWS_COST_METRIC]["Amount"]), 2)


def pct_change(current: float, previous: float) -> float:
    if previous == 0:
        return 0.0
    return round(((current - previous) / previous) * 100, 1)


def safe_budget(forecast: float) -> float:
    if AWS_MONTHLY_BUDGET:
        return float(AWS_MONTHLY_BUDGET)
    return round(forecast, 2)


def safe_unit_count(current: bool) -> float:
    raw = AWS_UNIT_COUNT if current else AWS_UNIT_COUNT_PREVIOUS
    if not raw:
        return 0.0
    return float(raw)


def get_forecast_metric() -> str:
    return FORECAST_METRIC_MAP.get(AWS_COST_METRIC, "UNBLENDED_COST")


def normalize_tag_value(raw_key: str) -> str:
    if "$" in raw_key:
        _, tag_value = raw_key.split("$", 1)
        if tag_value:
            return tag_value
    return "Unallocated"


def summarize_service_meta(label: str) -> str:
    messages = {
        "Amazon Elastic Compute Cloud - Compute": "Compute remains the largest leverage point for rightsizing and commitment coverage.",
        "Amazon Relational Database Service": "Database demand is climbing; storage, I/O, and instance classes deserve closer review.",
        "Amazon Simple Storage Service": "Storage lifecycle and tiering can usually unlock savings without product tradeoffs.",
        "AWS Data Transfer": "Cross-region and internet egress growth can quietly reshape spend faster than core compute.",
        "Amazon Elastic Kubernetes Service": "Cluster baseline is often healthy, but node pool utilization may still hide waste."
    }
    return messages.get(label, "Monitor this service closely; it is materially contributing to the monthly AWS bill.")


def summarize_environment_meta(label: str) -> str:
    label_lower = label.lower()
    if "prod" in label_lower:
        return "Production spend is expected; the goal is efficiency rather than raw suppression."
    if "stag" in label_lower or "uat" in label_lower:
        return "Staging is a common optimization target because it tends to be always-on but underused."
    if "dev" in label_lower or "sandbox" in label_lower or "test" in label_lower:
        return "Scheduling and guardrails here often produce the quickest operational savings."
    return "This environment grouping came from your AWS cost allocation tags."


def summarize_account_meta(account_id: str) -> str:
    return f"Linked account {account_id} from AWS Organizations cost allocation."


def build_insights(current_spend: float, budget: float, forecast: float, top_service: str, top_account: str, non_prod_pct: float):
    budget_delta = budget - forecast
    budget_text = (
        f"Forecast is {format_currency(abs(budget_delta))} below budget, keeping spend inside the current plan."
        if budget_delta >= 0
        else f"Forecast is {format_currency(abs(budget_delta))} above budget and needs intervention this month."
    )

    non_prod_text = (
        f"Non-production environments represent {non_prod_pct:.0f}% of tagged spend, which is the cleanest place to target fast savings."
        if non_prod_pct > 0
        else "Environment tags are missing or incomplete, so non-production savings opportunities are not fully visible yet."
    )

    return [
        {
            "title": "Budget posture",
            "body": budget_text
        },
        {
            "title": "Main cost driver",
            "body": f"{top_service} is currently the strongest service driver, while account {top_account} leads the linked-account view."
        },
        {
            "title": "Fastest efficiency move",
            "body": non_prod_text
        }
    ]


def get_forecast_amount(ce, today: date, next_month: date, fallback_amount: float) -> float:
    try:
        forecast_response = ce.get_cost_forecast(
            TimePeriod={"Start": today.isoformat(), "End": next_month.isoformat()},
            Metric=get_forecast_metric(),
            Granularity="MONTHLY",
        )
        return round(float(forecast_response["Total"]["Amount"]), 2)
    except ClientError as error:
        error_code = error.response.get("Error", {}).get("Code", "")
        if error_code == "DataUnavailableException":
            return fallback_amount
        raise


def format_currency(value: float) -> str:
    return f"${value:,.0f}"


def prune_sessions():
    now = int(time())
    expired = [token for token, payload in SESSIONS.items() if payload["expires_at"] <= now]
    for token in expired:
        SESSIONS.pop(token, None)


def hash_session_token(token: str) -> str:
    return hmac.new(SESSION_SECRET.encode("utf-8"), token.encode("utf-8"), hashlib.sha256).hexdigest()


def create_session(username: str) -> str:
    raw_token = secrets.token_urlsafe(32)
    SESSIONS[hash_session_token(raw_token)] = {
        "username": username,
        "expires_at": int(time()) + SESSION_DURATION_SECONDS,
    }
    return raw_token


def parse_cookies(handler) -> SimpleCookie:
    cookie = SimpleCookie()
    cookie.load(handler.headers.get("Cookie", ""))
    return cookie


def get_session(handler):
    if not AUTH_ENABLED:
        return {"username": "guest"}

    prune_sessions()
    cookie = parse_cookies(handler)
    morsel = cookie.get(SESSION_COOKIE_NAME)
    if not morsel:
        return None

    payload = SESSIONS.get(hash_session_token(morsel.value))
    if not payload:
        return None
    return payload


def clear_session(handler):
    cookie = parse_cookies(handler)
    morsel = cookie.get(SESSION_COOKIE_NAME)
    if morsel:
        SESSIONS.pop(hash_session_token(morsel.value), None)


def require_session(handler) -> bool:
    if get_session(handler):
        return True

    handler._send_json(401, {"error": "Authentication required."})
    return False


@lru_cache(maxsize=1)
def get_ce_client():
    if boto3 is None:
        raise RuntimeError("boto3 is not installed. Run `pip install -r requirements.txt` first.")

    session_kwargs = {"region_name": AWS_REGION}
    if AWS_PROFILE:
        session_kwargs["profile_name"] = AWS_PROFILE

    session = boto3.Session(**session_kwargs)
    return session.client("ce", region_name="us-east-1")


def fetch_cost_data():
    ce = get_ce_client()
    today = date.today()
    current_month = month_start(today)
    next_month = next_month_start(current_month)
    previous_month = shift_months(current_month, -1)
    six_month_start = shift_months(current_month, -5)

    monthly_history_response = ce.get_cost_and_usage(
        TimePeriod={"Start": six_month_start.isoformat(), "End": next_month.isoformat()},
        Granularity="MONTHLY",
        Metrics=[AWS_COST_METRIC],
    )
    monthly_history = [
        {
            "month": datetime.strptime(item["TimePeriod"]["Start"], "%Y-%m-%d").strftime("%b"),
            "value": parse_amount([item]),
        }
        for item in monthly_history_response["ResultsByTime"]
    ]

    current_month_response = ce.get_cost_and_usage(
        TimePeriod={"Start": current_month.isoformat(), "End": next_month.isoformat()},
        Granularity="MONTHLY",
        Metrics=[AWS_COST_METRIC],
    )
    previous_month_response = ce.get_cost_and_usage(
        TimePeriod={"Start": previous_month.isoformat(), "End": current_month.isoformat()},
        Granularity="MONTHLY",
        Metrics=[AWS_COST_METRIC],
    )

    current_month_spend = parse_amount(current_month_response["ResultsByTime"])
    previous_month_spend = parse_amount(previous_month_response["ResultsByTime"])

    forecast = get_forecast_amount(ce, today, next_month, current_month_spend)
    budget = safe_budget(forecast)

    services_response = ce.get_cost_and_usage(
        TimePeriod={"Start": current_month.isoformat(), "End": next_month.isoformat()},
        Granularity="MONTHLY",
        Metrics=[AWS_COST_METRIC],
        GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
    )
    top_services = sorted(
        [
            {
                "label": group["Keys"][0],
                "value": parse_group_amount(group),
                "meta": summarize_service_meta(group["Keys"][0]),
            }
            for group in services_response["ResultsByTime"][0]["Groups"]
            if parse_group_amount(group) > 0
        ],
        key=lambda item: item["value"],
        reverse=True,
    )[:5]

    accounts_response = ce.get_cost_and_usage(
        TimePeriod={"Start": current_month.isoformat(), "End": next_month.isoformat()},
        Granularity="MONTHLY",
        Metrics=[AWS_COST_METRIC],
        GroupBy=[{"Type": "DIMENSION", "Key": "LINKED_ACCOUNT"}],
    )
    accounts = sorted(
        [
            {
                "label": group["Keys"][0],
                "value": parse_group_amount(group),
                "meta": summarize_account_meta(group["Keys"][0]),
            }
            for group in accounts_response["ResultsByTime"][0]["Groups"]
            if parse_group_amount(group) > 0
        ],
        key=lambda item: item["value"],
        reverse=True,
    )[:4]

    environment_rows = []
    try:
        environments_response = ce.get_cost_and_usage(
            TimePeriod={"Start": current_month.isoformat(), "End": next_month.isoformat()},
            Granularity="MONTHLY",
            Metrics=[AWS_COST_METRIC],
            GroupBy=[{"Type": "TAG", "Key": AWS_COST_TAG_KEY}],
        )
        environment_groups = environments_response["ResultsByTime"][0]["Groups"]
        tagged_total = sum(parse_group_amount(group) for group in environment_groups)
        environment_rows = [
            {
                "label": normalize_tag_value(group["Keys"][0]),
                "value": round(parse_group_amount(group) / tagged_total, 4) if tagged_total else 0,
                "meta": summarize_environment_meta(normalize_tag_value(group["Keys"][0])),
            }
            for group in environment_groups
            if parse_group_amount(group) > 0
        ]
        environment_rows = sorted(environment_rows, key=lambda item: item["value"], reverse=True)[:4]
    except Exception:
        environment_rows = [
            {
                "label": "Unallocated",
                "value": 1,
                "meta": f"No {AWS_COST_TAG_KEY} tag data found in Cost Explorer. Activate that cost allocation tag to break spend down by environment.",
            }
        ]

    non_prod_pct = round(
        sum(
            row["value"]
            for row in environment_rows
            if all(token not in row["label"].lower() for token in ["prod", "production"])
        ) * 100,
        1,
    )

    unit_count = safe_unit_count(True)
    unit_count_previous = safe_unit_count(False)
    unit_cost = round(current_month_spend / unit_count, 2) if unit_count else 0
    unit_cost_previous = round(previous_month_spend / unit_count_previous, 2) if unit_count_previous else 0

    forecast_variance_pct = pct_change(forecast, budget) if budget else 0.0
    unallocated_spend_pct = next(
        (row["value"] for row in environment_rows if row["label"].lower() == "unallocated"),
        0.0,
    )
    savings_opportunity = round(current_month_spend * (non_prod_pct / 100) * 0.15, 2)
    savings_plan_coverage = 0.0
    top_service_label = top_services[0]["label"] if top_services else "No service data"
    top_account_label = accounts[0]["label"] if accounts else "No linked accounts"

    return {
        "summary": {
            "currentMonthSpend": current_month_spend,
            "previousMonthSpend": previous_month_spend,
            "monthOverMonthPct": pct_change(current_month_spend, previous_month_spend),
            "forecast": forecast,
            "budget": budget,
            "forecastVariancePct": forecast_variance_pct,
            "savingsOpportunity": savings_opportunity,
            "savingsPlanCoverage": savings_plan_coverage,
            "unitCost": unit_cost,
            "unitCostDeltaPct": pct_change(unit_cost, unit_cost_previous) if unit_cost_previous else 0.0,
            "unallocatedSpendPct": round(unallocated_spend_pct, 4),
            "unallocatedSpendDeltaPct": 0.0,
            "anomalyWatch": top_service_label,
            "largestDriver": top_account_label,
        },
        "monthlyHistory": monthly_history,
        "topServices": top_services,
        "environments": environment_rows,
        "accounts": accounts,
        "insights": build_insights(
            current_spend=current_month_spend,
            budget=budget,
            forecast=forecast,
            top_service=top_service_label,
            top_account=top_account_label,
            non_prod_pct=non_prod_pct,
        ),
    }


def default_infra_ops_data():
    return {
        "incidents": [],
        "services": [],
    }


def load_infra_ops_data():
    if not INFRA_OPS_DATA_PATH.exists():
        default_payload = default_infra_ops_data()
        write_json_file(INFRA_OPS_DATA_PATH, default_payload)
        return default_payload

    payload = read_json_file(INFRA_OPS_DATA_PATH)
    return {
        "incidents": payload.get("incidents", []),
        "services": payload.get("services", []),
    }


def validate_infra_ops_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("Payload must be a JSON object.")

    incidents = payload.get("incidents")
    services = payload.get("services")

    if not isinstance(incidents, list) or not isinstance(services, list):
        raise ValueError("Payload must include 'incidents' and 'services' arrays.")

    for incident in incidents:
        required = ["id", "title", "severity", "owner", "status", "service", "startedAt", "summary", "nextAction"]
        if not isinstance(incident, dict) or any(not incident.get(key) for key in required):
            raise ValueError("Each incident must include id, title, severity, owner, status, service, startedAt, summary, and nextAction.")

    for service in services:
        required = ["name", "environment", "owner", "backupOwner", "criticality", "meta"]
        if not isinstance(service, dict) or any(not service.get(key) for key in required):
            raise ValueError("Each service must include name, environment, owner, backupOwner, criticality, and meta.")
        if "openIncidents" not in service:
            raise ValueError("Each service must include openIncidents.")


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _send_json(self, status_code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _is_secure_request(self) -> bool:
        return self.headers.get("X-Forwarded-Proto", "http") == "https"

    def _send_cookie(self, token: str):
        secure = "; Secure" if self._is_secure_request() else ""
        self.send_header(
            "Set-Cookie",
            f"{SESSION_COOKIE_NAME}={token}; HttpOnly; Path=/; SameSite=Lax; Max-Age={SESSION_DURATION_SECONDS}{secure}",
        )

    def _clear_cookie(self):
        secure = "; Secure" if self._is_secure_request() else ""
        self.send_header(
            "Set-Cookie",
            f"{SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0{secure}",
        )

    def _read_json_body(self):
        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length) if content_length else b"{}"
        return json.loads(raw_body.decode("utf-8"))

    def do_GET(self):
        if self.path == "/api/session":
            session = get_session(self)
            self._send_json(
                200,
                {
                    "authenticated": bool(session),
                    "authEnabled": AUTH_ENABLED,
                    "username": session["username"] if session else None,
                },
            )
            return

        if self.path == "/api/cost-data":
            if not require_session(self):
                return
            try:
                payload = fetch_cost_data()
                self._send_json(200, payload)
            except Exception as error:  # pragma: no cover - manual runtime path
                self._send_json(
                    500,
                    {
                        "error": str(error),
                        "hint": "Check AWS credentials, Cost Explorer access, and whether boto3 is installed.",
                    },
                )
            return

        if self.path == "/api/infra-ops-data":
            if not require_session(self):
                return
            try:
                self._send_json(200, load_infra_ops_data())
            except Exception as error:  # pragma: no cover - manual runtime path
                self._send_json(500, {"error": str(error)})
            return

        return super().do_GET()

    def do_PUT(self):
        if self.path != "/api/infra-ops-data":
            self._send_json(404, {"error": "Not found"})
            return

        if not require_session(self):
            return

        try:
            payload = self._read_json_body()
            validate_infra_ops_payload(payload)
            write_json_file(
                INFRA_OPS_DATA_PATH,
                {
                    "incidents": payload["incidents"],
                    "services": payload["services"],
                },
            )
            self._send_json(200, {"status": "ok"})
        except ValueError as error:
            self._send_json(400, {"error": str(error)})
        except Exception as error:  # pragma: no cover - manual runtime path
            self._send_json(500, {"error": str(error)})

    def do_POST(self):
        if self.path != "/api/session":
            self._send_json(404, {"error": "Not found"})
            return

        if not AUTH_ENABLED:
            self._send_json(
                400,
                {"error": "Authentication is not configured. Set AUTH_USERNAME and AUTH_PASSWORD."},
            )
            return

        try:
            payload = self._read_json_body()
            username = str(payload.get("username", "")).strip()
            password = str(payload.get("password", ""))

            if username != AUTH_USERNAME or password != AUTH_PASSWORD:
                self._send_json(401, {"error": "Invalid username or password."})
                return

            token = create_session(username)
            body = json.dumps({"authenticated": True, "authEnabled": True, "username": username}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self._send_cookie(token)
            self.end_headers()
            self.wfile.write(body)
        except Exception as error:  # pragma: no cover - manual runtime path
            self._send_json(500, {"error": str(error)})

    def do_DELETE(self):
        if self.path != "/api/session":
            self._send_json(404, {"error": "Not found"})
            return

        clear_session(self)
        body = json.dumps({"status": "ok"}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._clear_cookie()
        self.end_headers()
        self.wfile.write(body)


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), DashboardHandler)
    print(f"Serving dashboard on http://localhost:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
