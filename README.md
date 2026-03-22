# InfraOps Hub

This is a lightweight internal operations dashboard for an infrastructure leader. It combines AWS cost visibility with starter workflows for incidents, service ownership, and weekly reporting. It supports live AWS Cost Explorer data through a small Python server, with sample JSON files still available as a fallback.

## What it includes

- Executive dashboard with cost, incident, ownership, and risk signals
- Editable incident tracker with local persistence
- Editable service registry with local persistence
- Weekly leadership summary draft
- AWS cost trend chart and cost breakdowns
- Sample data fallback when live AWS data is unavailable

## Connect it to your AWS account

1. Install the Python dependency:

```bash
pip3 install -r requirements.txt
```

2. Copy the example environment file and fill in your AWS settings:

```bash
cp .env.example .env
```

Important fields:

- `AWS_PROFILE`: your local AWS CLI profile name
- `AWS_REGION`: usually `us-east-1` for Cost Explorer access
- `AWS_MONTHLY_BUDGET`: optional, used for the executive budget comparison
- `AWS_COST_TAG_KEY`: your environment tag, for example `Environment`
- `AWS_UNIT_COUNT` and `AWS_UNIT_COUNT_PREVIOUS`: optional business volume numbers if you want unit-cost KPIs

3. Start the dashboard server:

```bash
python3 server.py
```

Then open [http://localhost:8000](http://localhost:8000).

If live AWS data is unavailable, the frontend automatically falls back to `/data/cost-data.json`.

Incident and service edits are stored in `/data/infra-ops-data.json`.

## AWS prerequisites

Your AWS identity needs Cost Explorer access, and Cost Explorer must already be enabled in the account.

Typical IAM permissions:

- `ce:GetCostAndUsage`
- `ce:GetCostForecast`

For better environment breakdowns, make sure your cost allocation tag such as `Environment` is activated in AWS Billing.

## Sample-data fallback

Edit `/data/cost-data.json` if you want to keep using manual data instead of live AWS data. The UI will still render from that file whenever the API is unavailable.

Edit `/data/infra-ops-data.json` if you want to seed or reset the locally stored incidents and services.

Useful source fields to export from AWS:

- Cost Explorer monthly spend
- Budget and forecast
- Linked account totals
- Service-level costs
- Tag-based environment costs
- Savings Plans and RI coverage
- Anomaly or outlier notes

## Next step ideas

- Add date filters and monthly drill-down
- Add budget alerts and anomaly thresholds
- Add AWS Budgets API integration instead of a manual budget value
- Add Savings Plans coverage and reservation utilization APIs
- Export the view for leadership reporting
- Move incident and service data to a real database

## Deploy on Render

This repo includes [`render.yaml`](/Users/patrickkong/codex/AWS-Cost/render.yaml) so you can deploy it as a Python web service directly from GitHub.

1. Push your latest changes to GitHub.
2. In Render, click `New +` then `Blueprint`.
3. Connect your GitHub account and choose this repository.
4. Render will detect `render.yaml` and create the web service.
5. If you want live AWS cost data in production, add the same environment variables from `.env.example` in the Render dashboard.

Important:

- Without AWS credentials, the deployed app will still work, but it will use sample cost data.
- The current incident and service storage uses a local JSON file. On most cloud platforms, including simple web-service deployments, local filesystem writes are not durable across redeploys or restarts. For production persistence, move that data into a database such as Render Postgres.
