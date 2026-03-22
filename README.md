# AWS Cost Executive Dashboard

This is a lightweight executive dashboard for presenting AWS cost data. It now supports live AWS Cost Explorer data through a small local Python server, with the sample JSON file still available as a fallback.

## What it includes

- Executive headline with current spend, forecast, budget, and savings signals
- KPI cards for spend growth, forecast variance, unit cost, and unallocated spend
- A monthly spend trend chart
- Top service, environment, and account breakdowns
- Short leadership-ready narrative insights

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

## AWS prerequisites

Your AWS identity needs Cost Explorer access, and Cost Explorer must already be enabled in the account.

Typical IAM permissions:

- `ce:GetCostAndUsage`
- `ce:GetCostForecast`

For better environment breakdowns, make sure your cost allocation tag such as `Environment` is activated in AWS Billing.

## Sample-data fallback

Edit `/data/cost-data.json` if you want to keep using manual data instead of live AWS data. The UI will still render from that file whenever the API is unavailable.

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
