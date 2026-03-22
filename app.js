const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});

const fallbackText = "N/A";

const staticContent = {
  weeklyBrief: [
    {
      title: "Top operational focus",
      body: "Use the incident tracker to keep priority response work, owners, and next actions visible.",
    },
    {
      title: "Cost watch",
      body: "AWS cost remains live through the existing endpoint, so the cost screen can keep evolving independently.",
    },
    {
      title: "Leadership ask",
      body: "Fill ownership gaps on tier-0 services before the next maintenance window.",
    },
  ],
  adminCards: [
    {
      title: "AWS Cost Explorer",
      status: "Connected",
      note: "Uses the existing /api/cost-data endpoint when AWS credentials are available.",
    },
    {
      title: "Infra Ops Store",
      status: "Connected",
      note: "Incidents and services now persist to data/infra-ops-data.json through the local API.",
    },
    {
      title: "PagerDuty / Jira",
      status: "Planned",
      note: "The next integration step is replacing manual incident entry with external sources.",
    },
  ],
};

const state = {
  costData: null,
  opsData: { incidents: [], services: [] },
  source: "sample",
  currentScreen: "dashboard",
  selectedIncidentId: null,
  selectedServiceName: null,
  saveStatus: "Loading workspace data",
};

const formatMoney = (value) => currency.format(value);
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const formatMoneySafe = (value) => (isFiniteNumber(value) ? formatMoney(value) : fallbackText);
const formatPercentSafe = (value) =>
  isFiniteNumber(value) ? percentFormatter.format(value) : fallbackText;
const formatDeltaSafe = (value) => (isFiniteNumber(value) ? formatDelta(value) : fallbackText);

const formatDelta = (value) => {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
};

const metricDirection = (value, preferred = "down") => {
  const positive = value >= 0;
  if (preferred === "up") {
    return positive ? "down" : "up";
  }
  return positive ? "up" : "down";
};

const sum = (values) => values.reduce((total, value) => total + value, 0);

const makeEl = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
};

const makeBadge = (text, tone) => makeEl("span", `badge ${tone}`, text);

const deriveRiskRows = () => {
  const tierZeroGaps = state.opsData.services.filter(
    (service) =>
      service.criticality === "Tier 0" &&
      (!service.backupOwner || ["Unassigned", "No backup owner"].includes(service.backupOwner))
  ).length;
  const unresolvedIncidents = state.opsData.incidents.filter(
    (incident) => incident.status !== "Resolved"
  ).length;
  const unassignedServices = state.opsData.services.filter(
    (service) => !service.owner || service.owner === "Unassigned"
  ).length;

  return [
    {
      label: "Tier-0 backup gaps",
      value: tierZeroGaps || 1,
      meta: `${tierZeroGaps} critical services still need resilient secondary ownership.`,
    },
    {
      label: "Unresolved incidents",
      value: unresolvedIncidents || 1,
      meta: `${unresolvedIncidents} incidents still require active attention or monitoring.`,
    },
    {
      label: "Unassigned services",
      value: unassignedServices || 1,
      meta: `${unassignedServices} services still need a named primary owner.`,
    },
  ];
};

const deriveReportHighlights = () => {
  const openIncidents = state.opsData.incidents.filter((incident) => incident.status !== "Resolved");
  const tierZeroGaps = state.opsData.services.filter(
    (service) =>
      service.criticality === "Tier 0" &&
      (!service.backupOwner || ["Unassigned", "No backup owner"].includes(service.backupOwner))
  ).length;

  return [
    {
      title: "Incidents",
      body: `${openIncidents.length} active incidents are open across the tracked service list.`,
    },
    {
      title: "Cost",
      body: state.costData
        ? `Forecast is ${formatMoneySafe(state.costData.summary.forecast)} against a budget of ${formatMoneySafe(
            state.costData.summary.budget
          )}.`
        : "Cost data is still loading.",
    },
    {
      title: "Governance",
      body: `${tierZeroGaps} tier-0 services still need stronger backup-owner coverage.`,
    },
  ];
};

const deriveReportBody = () => {
  const openIncidents = state.opsData.incidents.filter((incident) => incident.status !== "Resolved");
  const highestIncident = openIncidents[0];
  const costSummary = state.costData?.summary;

  return [
    highestIncident
      ? `This week the main operational focus is ${highestIncident.title.toLowerCase()}, currently owned by ${highestIncident.owner} and tracked as ${highestIncident.severity}.`
      : "This week there are no active incidents in the tracker, which gives the team room to focus on prevention and cleanup.",
    costSummary
      ? `AWS spend is ${formatMoneySafe(costSummary.currentMonthSpend)} month to date with a forecast of ${formatMoneySafe(costSummary.forecast)}.`
      : "AWS cost data is not yet available in the current session.",
    `Service governance still needs attention: ${state.opsData.services.filter((service) => service.owner === "Unassigned").length} services are missing a clear primary owner, and ${state.opsData.services.filter((service) => ["Unassigned", "No backup owner"].includes(service.backupOwner)).length} are missing reliable backup coverage.`,
  ];
};

const getSelectedIncident = () =>
  state.opsData.incidents.find((incident) => incident.id === state.selectedIncidentId) ||
  state.opsData.incidents[0] ||
  null;

const getSelectedService = () =>
  state.opsData.services.find((service) => service.name === state.selectedServiceName) ||
  state.opsData.services[0] ||
  null;

const renderScreenVisibility = () => {
  document.querySelectorAll("[data-screen]").forEach((section) => {
    section.classList.toggle("is-hidden", section.dataset.screen !== state.currentScreen);
  });

  document.querySelectorAll("[data-screen-link]").forEach((link) => {
    link.classList.toggle("active", link.dataset.screenLink === state.currentScreen);
  });

  const indicator = document.querySelector("#screen-indicator");
  if (indicator) {
    indicator.textContent = state.currentScreen.replace("-", " ");
  }
};

const renderSaveStatus = () => {
  const saveStatus = document.querySelector("#save-status");
  if (saveStatus) {
    saveStatus.textContent = state.saveStatus;
  }
};

const renderSourceNotice = () => {
  const existing = document.querySelector(".source-notice");
  existing?.remove();

  if (state.source !== "sample") {
    return;
  }

  const notice = makeEl(
    "div",
    "source-notice",
    "Live AWS data is unavailable, so the cost screen is showing sample data while incidents and services persist locally."
  );
  document.querySelector(".content-shell")?.prepend(notice);
};

const renderHeadline = () => {
  const container = document.querySelector("#headline-card");
  const data = state.costData;
  const openIncidentCount = state.opsData.incidents.filter((item) => item.status !== "Resolved").length;
  const tierZeroGaps = state.opsData.services.filter(
    (service) =>
      service.criticality === "Tier 0" &&
      (!service.backupOwner || ["Unassigned", "No backup owner"].includes(service.backupOwner))
  ).length;

  container.innerHTML = "";
  const primary = makeEl("div", "detail-card");
  primary.append(
    makeEl("p", "mini-label", "Current Month Spend"),
    makeEl("div", "headline-value", formatMoneySafe(data?.summary.currentMonthSpend)),
    makeEl(
      "p",
      "headline-meta",
      `Forecast ${formatMoneySafe(data?.summary.forecast)} against budget ${formatMoneySafe(data?.summary.budget)}`
    ),
    makeEl(
      "div",
      `delta ${metricDirection(data?.summary.monthOverMonthPct ?? 0)}`,
      `${formatDeltaSafe(data?.summary.monthOverMonthPct)} vs last month`
    )
  );

  const statGrid = makeEl("div", "detail-row");
  [
    ["Active incidents", String(openIncidentCount)],
    ["Tier-0 gaps", `${tierZeroGaps} services`],
    ["Largest cost driver", data?.summary.anomalyWatch || fallbackText],
    ["Lead account", data?.summary.largestDriver || fallbackText],
  ].forEach(([label, value]) => {
    const card = makeEl("div", "detail-card");
    card.append(makeEl("p", "mini-label", label), makeEl("div", "detail-value", value));
    statGrid.append(card);
  });

  container.append(primary, statGrid);
};

const renderKpis = () => {
  const kpiGrid = document.querySelector("#kpi-grid");
  const data = state.costData;
  const servicesWithCoverage = state.opsData.services.filter(
    (service) =>
      service.owner &&
      service.owner !== "Unassigned" &&
      service.backupOwner &&
      !["Unassigned", "No backup owner"].includes(service.backupOwner)
  ).length;
  const coveragePct = state.opsData.services.length
    ? (servicesWithCoverage / state.opsData.services.length) * 100
    : 0;

  kpiGrid.innerHTML = "";

  const cards = [
    {
      label: "Month-to-Date Spend",
      value: formatMoneySafe(data?.summary.currentMonthSpend),
      detail: `Previous month ${formatMoneySafe(data?.summary.previousMonthSpend)}`,
      delta: data?.summary.monthOverMonthPct ?? 0,
    },
    {
      label: "Forecast vs Budget",
      value: formatDeltaSafe(data?.summary.forecastVariancePct),
      detail: "Positive means forecast is above budget",
      delta: data?.summary.forecastVariancePct ?? 0,
      preferred: "up",
    },
    {
      label: "Open Incidents",
      value: String(state.opsData.incidents.filter((item) => item.status !== "Resolved").length),
      detail: "Active operational issues across tracked services",
      delta: -8.3,
    },
    {
      label: "Ownership Coverage",
      value: `${coveragePct.toFixed(0)}%`,
      detail: "Services with both primary and backup owners assigned",
      delta: 9.0,
      preferred: "up",
    },
  ];

  cards.forEach((cardData) => {
    const card = makeEl("article", "kpi-card");
    card.append(
      makeEl("p", "mini-label", cardData.label),
      makeEl("div", "kpi-value", cardData.value),
      makeEl("p", "kpi-detail", cardData.detail),
      makeEl(
        "div",
        `delta ${metricDirection(cardData.delta, cardData.preferred || "down")}`,
        formatDeltaSafe(cardData.delta)
      )
    );
    kpiGrid.append(card);
  });
};

const renderInsights = () => {
  const container = document.querySelector("#insight-list");
  const data = state.costData;
  container.innerHTML = "";

  (data?.insights || []).forEach((item) => {
    const card = makeEl("article", "insight-card");
    card.append(makeEl("h3", "", item.title), makeEl("p", "", item.body));
    container.append(card);
  });
};

const renderStackList = (selector, rows, valueFormatter, selectedLabel) => {
  const container = document.querySelector(selector);
  container.innerHTML = "";
  const total = sum(rows.map((row) => row.value)) || 1;

  rows.forEach((row) => {
    const item = makeEl("article", "stack-item");
    if (row.onClick) {
      item.classList.add("is-clickable");
      item.addEventListener("click", row.onClick);
    }
    if (selectedLabel && row.label === selectedLabel) {
      item.classList.add("is-active");
    }

    const title = makeEl("div", "stack-title-row");
    title.append(makeEl("strong", "", row.label), makeEl("span", "stack-value", valueFormatter(row)));

    const bar = makeEl("div", "stack-bar");
    const fill = makeEl("div", "stack-fill");
    fill.style.width = `${(row.value / total) * 100}%`;
    bar.append(fill);

    item.append(title, bar, makeEl("p", "stack-meta", row.meta));
    container.append(item);
  });
};

const renderBriefList = (selector, rows) => {
  const container = document.querySelector(selector);
  container.innerHTML = "";
  rows.forEach((row) => {
    const card = makeEl("article", "brief-card");
    card.append(makeEl("h4", "", row.title), makeEl("p", "", row.body));
    container.append(card);
  });
};

const renderIncidentSummary = () => {
  const rows = state.opsData.incidents.map((incident) => ({
    label: `${incident.id} ${incident.title}`,
    value: incident.severity === "P1" ? 3 : incident.severity === "P2" ? 2 : 1,
    meta: `${incident.owner} · ${incident.status} · ${incident.service}`,
  }));
  renderStackList("#incident-summary", rows, (row) => row.meta);
};

const renderOwnershipGaps = () => {
  const rows = state.opsData.services
    .filter(
      (service) =>
        service.owner === "Unassigned" ||
        service.backupOwner === "No backup owner" ||
        service.backupOwner === "Unassigned"
    )
    .map((service) => ({
      label: service.name,
      value: service.criticality === "Tier 0" ? 3 : 2,
      meta: `${service.environment} · ${service.owner === "Unassigned" ? "Primary owner missing" : "Backup owner missing"}`,
    }));
  renderStackList("#ownership-gaps", rows, (row) => row.meta);
};

const renderRisks = () => {
  renderStackList("#risk-list", deriveRiskRows(), (row) => `${row.value} items`);
};

const renderIncidentTable = () => {
  const table = document.querySelector("#incident-table");
  table.innerHTML = "";

  state.opsData.incidents.forEach((incident) => {
    const tr = document.createElement("tr");
    tr.classList.toggle("is-selected", incident.id === state.selectedIncidentId);
    tr.addEventListener("click", () => {
      state.selectedIncidentId = incident.id;
      renderOpsViews();
    });

    [incident.id, incident.title, incident.severity, incident.owner, incident.status].forEach((text) => {
      tr.append(makeEl("td", "", text));
    });
    table.append(tr);
  });
};

const renderIncidentDetail = () => {
  const incident = getSelectedIncident();
  const container = document.querySelector("#incident-detail");
  const form = document.querySelector("#incident-form");
  container.innerHTML = "";

  if (!incident) {
    container.append(makeEl("p", "detail-copy", "No incidents yet."));
    form.reset();
    return;
  }

  const card = makeEl("article", "detail-card");
  const statusRow = makeEl("div", "topbar-actions");
  statusRow.append(
    makeBadge(incident.severity, incident.severity === "P1" ? "bad" : "warn"),
    makeBadge(incident.status, incident.status === "Resolved" ? "good" : "warn")
  );

  const info = makeEl("div", "detail-row");
  [
    ["Service", incident.service],
    ["Owner", incident.owner],
    ["Started", incident.startedAt],
    ["Next action", incident.nextAction],
  ].forEach(([label, value]) => {
    const detail = makeEl("div", "detail-card");
    detail.append(makeEl("p", "mini-label", label), makeEl("p", "detail-copy", value));
    info.append(detail);
  });

  card.append(
    makeEl("h4", "", incident.title),
    statusRow,
    makeEl("p", "detail-copy", incident.summary),
    info
  );
  container.append(card);

  Object.entries(incident).forEach(([key, value]) => {
    if (form.elements.namedItem(key)) {
      form.elements.namedItem(key).value = value;
    }
  });
};

const renderServices = () => {
  const rows = state.opsData.services.map((service) => ({
    label: service.name,
    value: Number(service.openIncidents) + 1,
    meta: `${service.environment} · ${service.owner} · ${service.criticality}`,
    onClick: () => {
      state.selectedServiceName = service.name;
      renderOpsViews();
    },
  }));
  renderStackList("#services-list", rows, (row) => row.meta, state.selectedServiceName);
};

const renderServiceDetail = () => {
  const service = getSelectedService();
  const container = document.querySelector("#service-detail");
  const form = document.querySelector("#service-form");
  container.innerHTML = "";

  if (!service) {
    container.append(makeEl("p", "detail-copy", "No services yet."));
    form.reset();
    return;
  }

  [
    { title: "Ownership", body: `${service.owner} primary · ${service.backupOwner} backup` },
    { title: "Criticality", body: `${service.criticality} service in ${service.environment}` },
    { title: "Open incidents", body: `${service.openIncidents} currently linked incidents.` },
    { title: "Operational context", body: service.meta },
  ].forEach((item) => {
    const card = makeEl("article", "detail-card");
    card.append(makeEl("h4", "", item.title), makeEl("p", "detail-copy", item.body));
    container.append(card);
  });

  Object.entries(service).forEach(([key, value]) => {
    if (form.elements.namedItem(key)) {
      form.elements.namedItem(key).value = value;
    }
  });
};

const renderCostViews = () => {
  const data = state.costData;
  renderStackList("#cost-services-list", data?.topServices || [], (row) => formatMoneySafe(row.value));
  renderStackList("#environment-list", data?.environments || [], (row) => formatPercentSafe(row.value));
  renderStackList("#accounts-list", data?.accounts || [], (row) => formatMoneySafe(row.value));
  renderSpendChart(data?.monthlyHistory || []);
};

const renderReport = () => {
  renderBriefList("#report-highlights", deriveReportHighlights());
  const body = document.querySelector("#report-body");
  body.innerHTML = "";
  deriveReportBody().forEach((paragraph) => {
    body.append(makeEl("p", "", paragraph));
  });
};

const renderAdminCards = () => {
  const container = document.querySelector("#admin-cards");
  container.innerHTML = "";

  staticContent.adminCards.forEach((item) => {
    const card = makeEl("article", "admin-card");
    const tone = item.status === "Connected" ? "good" : "warn";
    card.append(
      makeEl("h4", "", item.title),
      makeBadge(item.status, tone),
      makeEl("p", "detail-copy", item.note)
    );
    container.append(card);
  });
};

const renderLeadershipPrompt = () => {
  const focus = document.querySelector("#leadership-focus");
  const note = document.querySelector("#leadership-note");
  const topIncident = getSelectedIncident();
  focus.textContent = topIncident
    ? `Watch ${topIncident.service} and ${state.costData?.summary.anomalyWatch || "cost anomalies"}.`
    : `Watch ${state.costData?.summary.anomalyWatch || "cost anomalies"}.`;
  note.textContent =
    "The workspace now supports navigation, editing, and local persistence for the core InfraOps records.";
};

const renderSpendChart = (history) => {
  const svg = document.querySelector("#spend-chart");
  if (!svg) {
    return;
  }

  if (!history.length) {
    svg.innerHTML = "";
    return;
  }

  const width = 720;
  const height = 280;
  const padding = { top: 20, right: 20, bottom: 46, left: 44 };
  const maxValue = Math.max(...history.map((point) => point.value)) * 1.12;
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const xStep = history.length > 1 ? chartWidth / (history.length - 1) : 0;

  const points = history.map((point, index) => {
    const x = padding.left + xStep * index;
    const y = padding.top + chartHeight - (point.value / maxValue) * chartHeight;
    return { ...point, x, y };
  });

  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
  const areaPath = `${linePath} L ${points.at(-1).x} ${height - padding.bottom} L ${points[0].x} ${height - padding.bottom} Z`;

  const gridLines = Array.from({ length: 4 }, (_, index) => {
    const y = padding.top + (chartHeight / 3) * index;
    const value = maxValue - (maxValue / 3) * index;
    return `
      <line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="rgba(31,28,24,0.1)" stroke-dasharray="4 8" />
      <text x="0" y="${y + 4}" fill="rgba(109,101,91,0.9)" font-size="12">${formatMoneySafe(value)}</text>
    `;
  }).join("");

  const labels = points
    .map(
      (point) => `
      <text x="${point.x}" y="${height - 18}" text-anchor="middle" fill="rgba(109,101,91,0.9)" font-size="12">
        ${point.month}
      </text>
    `
    )
    .join("");

  const dots = points
    .map(
      (point) => `
      <circle cx="${point.x}" cy="${point.y}" r="5.5" fill="#fffaf3" stroke="#b7562d" stroke-width="3" />
      <text x="${point.x}" y="${point.y - 14}" text-anchor="middle" fill="#1f1c18" font-size="12" font-weight="600">
        ${formatMoneySafe(point.value)}
      </text>
    `
    )
    .join("");

  svg.innerHTML = `
    <defs>
      <linearGradient id="areaFill" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="rgba(183,86,45,0.34)" />
        <stop offset="100%" stop-color="rgba(183,86,45,0.05)" />
      </linearGradient>
    </defs>
    ${gridLines}
    <path d="${areaPath}" fill="url(#areaFill)"></path>
    <path
      d="${linePath}"
      fill="none"
      stroke="#b7562d"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="4"
    ></path>
    ${dots}
    ${labels}
  `;
};

const renderOpsViews = () => {
  renderIncidentSummary();
  renderOwnershipGaps();
  renderRisks();
  renderIncidentTable();
  renderIncidentDetail();
  renderServices();
  renderServiceDetail();
  renderHeadline();
  renderKpis();
  renderLeadershipPrompt();
  renderReport();
};

const renderApp = () => {
  renderScreenVisibility();
  renderSaveStatus();
  renderSourceNotice();
  renderHeadline();
  renderKpis();
  renderInsights();
  renderBriefList("#weekly-brief", staticContent.weeklyBrief);
  renderOpsViews();
  renderCostViews();
  renderReport();
  renderAdminCards();
};

const saveOpsData = async () => {
  state.saveStatus = "Saving changes";
  renderSaveStatus();

  const response = await fetch("./api/infra-ops-data", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.opsData),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Unable to save changes.");
  }

  state.saveStatus = "All changes saved";
  renderSaveStatus();
};

const fetchCostData = async () => {
  try {
    const liveResponse = await fetch("./api/cost-data");
    if (liveResponse.ok) {
      const payload = await liveResponse.json();
      return { data: payload, source: "live" };
    }
  } catch (error) {
    console.warn("Live AWS API unavailable, using sample data instead.", error);
  }

  const fallbackResponse = await fetch("./data/cost-data.json");
  return { data: await fallbackResponse.json(), source: "sample" };
};

const fetchOpsData = async () => {
  const response = await fetch("./api/infra-ops-data");
  if (!response.ok) {
    throw new Error("Unable to load incident and service data.");
  }
  return response.json();
};

const bindNavigation = () => {
  document.querySelectorAll("[data-screen-link]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      state.currentScreen = link.dataset.screenLink;
      renderScreenVisibility();
    });
  });
};

const bindActions = () => {
  document.querySelector("#weekly-summary-button")?.addEventListener("click", () => {
    state.currentScreen = "weekly-report";
    renderScreenVisibility();
    renderReport();
  });

  document.querySelector("#new-incident-button")?.addEventListener("click", () => {
    const draft = {
      id: `INC-${String(Date.now()).slice(-4)}`,
      title: "New incident",
      severity: "P2",
      owner: "Unassigned",
      status: "Investigating",
      service: state.opsData.services[0]?.name || "Unassigned",
      startedAt: "Just now",
      summary: "Describe the impact and current state.",
      nextAction: "Describe the next response step.",
    };
    state.opsData.incidents.unshift(draft);
    state.selectedIncidentId = draft.id;
    renderOpsViews();
  });

  document.querySelector("#new-service-button")?.addEventListener("click", () => {
    const draft = {
      name: `New Service ${state.opsData.services.length + 1}`,
      environment: "Staging",
      owner: "Unassigned",
      backupOwner: "Unassigned",
      criticality: "Tier 2",
      openIncidents: 0,
      meta: "Add runbook, dashboard, repo, and dependency notes here.",
    };
    state.opsData.services.unshift(draft);
    state.selectedServiceName = draft.name;
    renderOpsViews();
  });

  document.querySelector("#incident-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const incident = Object.fromEntries(formData.entries());
    const existingIndex = state.opsData.incidents.findIndex((item) => item.id === state.selectedIncidentId);
    const duplicateIndex = state.opsData.incidents.findIndex(
      (item) => item.id === incident.id && item.id !== state.selectedIncidentId
    );

    if (duplicateIndex >= 0) {
      state.saveStatus = "Incident ID already exists";
      renderSaveStatus();
      return;
    }

    if (existingIndex >= 0) {
      state.opsData.incidents[existingIndex] = incident;
    } else {
      state.opsData.incidents.unshift(incident);
    }
    state.selectedIncidentId = incident.id;
    renderOpsViews();

    try {
      await saveOpsData();
    } catch (error) {
      state.saveStatus = error.message;
      renderSaveStatus();
    }
  });

  document.querySelector("#service-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const service = Object.fromEntries(formData.entries());
    service.openIncidents = Number(service.openIncidents || 0);

    const existingIndex = state.opsData.services.findIndex(
      (item) => item.name === state.selectedServiceName
    );
    const duplicateIndex = state.opsData.services.findIndex(
      (item) => item.name === service.name && item.name !== state.selectedServiceName
    );

    if (duplicateIndex >= 0) {
      state.saveStatus = "Service name already exists";
      renderSaveStatus();
      return;
    }

    if (existingIndex >= 0) {
      state.opsData.services[existingIndex] = service;
    } else {
      state.opsData.services.unshift(service);
    }

    state.selectedServiceName = service.name;
    renderOpsViews();

    try {
      await saveOpsData();
    } catch (error) {
      state.saveStatus = error.message;
      renderSaveStatus();
    }
  });
};

const init = async () => {
  const [{ data, source }, opsData] = await Promise.all([fetchCostData(), fetchOpsData()]);
  state.costData = data;
  state.source = source;
  state.opsData = opsData;
  state.selectedIncidentId = opsData.incidents[0]?.id || null;
  state.selectedServiceName = opsData.services[0]?.name || null;
  state.saveStatus = "All changes saved";

  bindNavigation();
  bindActions();
  renderApp();
};

init().catch((error) => {
  document.body.innerHTML = `<pre>Unable to load dashboard data.\n${error.message}</pre>`;
});
