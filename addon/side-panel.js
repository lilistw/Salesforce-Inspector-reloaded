/* global React ReactDOM */
import {sfConn, apiVersion} from "./inspector.js";
import {getBrowserType, createSpinForMethod, copyToClipboard, StorageHistory, Constants, UserInfoModel, getRedirectUri} from "./utils.js";
import {CometD} from "./lib/cometd/cometd.js";
import ConfirmModal from "./components/ConfirmModal.js";
import {getSourceOrgs, saveSourceOrg, removeSourceOrg, getSourceOrgToken, initiateSourceOrgOAuth} from "./source-org-manager.js";

const h = React.createElement;

// ─── Channel definitions ──────────────────────────────────────────────────────

const CHANNEL_TYPES = [
  {value: "platformEvent",         label: "Custom Platform Event", prefix: "/event/"},
  {value: "standardPlatformEvent", label: "Standard Platform Event", prefix: "/event/"},
  {value: "changeEvent",           label: "Change Event", prefix: "/data/"},
  {value: "customChannel",         label: "Custom Channel", prefix: "/event/"},
  {value: "realTimeEvent",         label: "Real-Time Event", prefix: "/event/"}
];

const PUBLISHABLE_TYPES = new Set(["platformEvent", "standardPlatformEvent"]);

// System fields injected by Salesforce that must be stripped before re-publishing
const SYSTEM_FIELDS = new Set(["CreatedById", "CreatedDate", "EventUuid", "SequenceNumber", "ReplayId"]);

// Reconnect backoff delays (ms)
const BACKOFF = [1000, 2000, 5000, 10000];

// ─── Utilities ────────────────────────────────────────────────────────────────

function pad(n, d) { return `000${n}`.slice(-d); }

function fmtTime(d) {
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`;
}

function generateRandomValue(field) {
  const type = (field.type || "").toLowerCase();
  const maxLen = field.length || 255;
  switch (type) {
    case "string": case "textarea": case "longtextarea": case "url": case "email": case "phone": {
      const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
      let s = ""; const len = Math.min(maxLen, Math.max(5, Math.floor(Math.random() * 18)));
      for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    }
    case "boolean": return Math.random() < 0.5;
    case "int": return Math.floor(Math.random() * 10000);
    case "double": case "currency": case "percent": return Math.round(Math.random() * 1000 * 100) / 100;
    case "date": { const d = new Date(); d.setDate(d.getDate() + Math.floor(Math.random() * 7) - 3); return `${pad(d.getFullYear(),4)}-${pad(d.getMonth()+1,2)}-${pad(d.getDate(),2)}`; }
    case "datetime": { const d = new Date(); return `${pad(d.getFullYear(),4)}-${pad(d.getMonth()+1,2)}-${pad(d.getDate(),2)}T${pad(d.getHours(),2)}:${pad(d.getMinutes(),2)}:${pad(d.getSeconds(),2)}.000Z`; }
    case "picklist": case "multipicklist":
      return field.picklistValues?.length ? field.picklistValues[Math.floor(Math.random() * field.picklistValues.length)].value : "Unknown";
    case "reference": case "id": case "address": case "location": return undefined;
    default: return "val_" + Math.random().toString(36).slice(2, 8);
  }
}

// Make a REST call to an arbitrary Salesforce org using a given token
async function restForOrg(sfHost, token, path) {
  const res = await fetch(`https://${sfHost}${path}`, {
    headers: {Authorization: `Bearer ${token}`, Accept: "application/json"}
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? ": " + body.slice(0, 200) : ""}`);
  }
  return res.json();
}

// Strip system fields and republish payload to the current org
async function publishToCurrentOrg(eventName, rawPayload) {
  const payload = Object.fromEntries(
    Object.entries(rawPayload || {}).filter(([k]) => !SYSTEM_FIELDS.has(k))
  );
  return sfConn.rest(`/services/data/v${apiVersion}/sobjects/${eventName}`, {method: "POST", body: payload});
}

// ─── Model ────────────────────────────────────────────────────────────────────

class Model {
  constructor(sfHost, sessionId) {
    this.sfHost = sfHost;
    this.sessionId = sessionId;
    this.sfLink = "https://" + sfHost;
    this.spinnerCount = 0;

    // Current org metadata
    this.orgName = sfHost.split(".")[0]?.toUpperCase() || "";
    this.isSandbox = localStorage.getItem(sfHost + "_isSandbox") === "true";

    // UI state
    this.collapsed = false;
    this.showHelp = false;

    // Channel selection
    this.selectedChannelType = "platformEvent";
    this.channels = [];
    this.channelCache = {};       // channelType → array
    this.selectedChannel = "";
    this.customChannelPath = "";
    this.replayId = -1;

    // Subscription state
    this.isListening = false;
    this.channelListening = "";
    this.channelError = "";
    this.cometd = null;
    this.subscription = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.popConfirmed = false;
    this.showReplayWarning = false;

    // Events
    this.events = [];
    this.eventFilter = "";
    this.selectedEvent = null;
    this.selectedEventIndex = undefined;

    // Publish metrics
    this.publishedCount = 0;
    this.isPublishing = false;

    // Source org
    this.sourceOrgs = [];
    this.selectedSourceOrgHost = "";  // "" = current org
    this.sourceOrgError = "";

    // Connect org dialog
    this.showConnectDialog = false;
    this.connectOrgType = "production";
    this.connectOrgCustomHost = "";
    this.connectOrgClientId = "";
    this.connectOrgCallbackUri = getRedirectUri("data-export.html");
    this.connectOrgError = "";
    this.connectOrgLoading = false;

    // Generate event dialog
    this.showGenerateDialog = false;
    this.generatePayload = "";
    this.generateLoading = false;
    this.generateError = "";
    this.generateDescribeFields = null;
    this.generateDescribeChannel = null;

    // History / saved
    this.eventHistory = new StorageHistory(sfHost + "_semPublishHistory", 20, {
      isValidEntry: e => typeof e === "object" && e.channel && e.payload !== undefined,
      matchAdd: (e, ent) => e.channel === ent.channel && e.payload === ent.payload,
      matchRemove: (e, ent) => e.key === ent.key,
      addToFront: true
    });

    this.spinFor = createSpinForMethod(this);
    this.userInfoModel = new UserInfoModel(this.spinFor.bind(this));

    // Load source orgs async
    this.loadSourceOrgs();
  }

  async loadSourceOrgs() {
    this.sourceOrgs = await getSourceOrgs();
    this.didUpdate();
  }

  getSelectedSourceOrg() {
    return this.sourceOrgs.find(o => o.sfHost === this.selectedSourceOrgHost) || null;
  }

  didUpdate(cb) {
    if (this.reactCallback) this.reactCallback(cb);
  }

  clearEvents() {
    this.events = [];
    this.eventFilter = "";
    this.selectedEvent = null;
    this.selectedEventIndex = undefined;
  }
}

// ─── App (React component) ────────────────────────────────────────────────────

class App extends React.Component {
  constructor(props) {
    super(props);
    this.state = {peLimits: []};

    // Bind all handlers
    const methods = [
      "onToggleCollapse", "onChannelTypeChange", "onChannelChange", "onCustomChannelInput",
      "onReplayIdChange", "onSubscribe", "onUnsubscribe",
      "onSelectEvent", "onCopyAsJson", "onClearEvents",
      "onEventFilterInput", "onClearFilter",
      "onSourceOrgChange", "onConnectOrgClick", "onConnectOrgTypeChange",
      "onConnectOrgCustomHostInput", "onConnectOrgClientIdInput", "onCopyConnectCallback",
      "onConfirmConnect", "onCancelConnect",
      "onRemoveSourceOrg", "onPublishCheckboxChange",
      "onGenerateClick", "onConfirmGenerate", "onCancelGenerate",
      "onGeneratePayloadChange", "onRegeneratePayload",
      "onSelectHistoryEntry",
      "onReplayWarningYes", "onReplayWarningNo"
    ];
    methods.forEach(m => { this[m] = this[m].bind(this); });

    // Load initial channel list
    this.loadChannels();

    // Listen for source org OAuth callback
    this._sourceOrgMsgHandler = (ev) => {
      if (ev.data?.type === "sourceOrgConnected") {
        const {sfHost} = ev.data;
        // Persist the new org (fetch its name from API)
        this.finalizeSourceOrgConnect(sfHost);
      }
    };
    window.addEventListener("message", this._sourceOrgMsgHandler);
  }

  componentWillUnmount() {
    window.removeEventListener("message", this._sourceOrgMsgHandler);
  }

  // ── Channel loading ──────────────────────────────────────────────────────────

  async loadChannels() {
    const {model} = this.props;
    const type = model.selectedChannelType;
    if (model.channelCache[type]) {
      model.channels = model.channelCache[type];
      model.selectedChannel = model.channels[0]?.name || "";
      model.didUpdate();
      return;
    }
    model.spinnerCount++;
    model.didUpdate();
    try {
      const channels = await this.fetchChannels(type);
      model.channelCache[type] = channels.length ? channels : [{name: null, label: "No channels found"}];
      model.channels = model.channelCache[type];
      model.selectedChannel = channels[0]?.name || "";
    } catch (err) {
      model.channelError = err.message || String(err);
    }
    model.spinnerCount--;
    model.didUpdate();
  }

  async fetchChannels(channelType) {
    const {model} = this.props;
    const isSource = !!model.selectedSourceOrgHost;
    const orgHost = isSource ? model.selectedSourceOrgHost : model.sfHost;
    const token = isSource ? getSourceOrgToken(orgHost) : model.sessionId;

    // Build query
    let query;
    const initial = [];
    if (channelType === "standardPlatformEvent") {
      query = "SELECT Label, QualifiedApiName FROM EntityDefinition"
        + " WHERE IsCustomizable = FALSE AND IsEverCreatable = TRUE"
        + " AND QualifiedApiName LIKE '%Event' AND (NOT QualifiedApiName LIKE '%ChangeEvent')"
        + " ORDER BY Label ASC LIMIT 200";
    } else if (channelType === "platformEvent") {
      query = "SELECT QualifiedApiName, Label FROM EntityDefinition WHERE isCustomizable = TRUE AND KeyPrefix LIKE 'e%' ORDER BY Label ASC";
    } else if (channelType === "customChannel") {
      query = "SELECT FullName, MasterLabel FROM PlatformEventChannel ORDER BY DeveloperName";
    } else if (channelType === "changeEvent") {
      initial.push({name: "ChangeEvents", label: "All Change Events"});
      query = "SELECT MasterLabel, SelectedEntity FROM PlatformEventChannelMember WHERE EventChannel = 'ChangeEvents' ORDER BY MasterLabel";
    } else if (channelType === "realTimeEvent") {
      query = "SELECT EntityName FROM RealTimeEvent WHERE IsEnabled = true ORDER BY EntityName";
    }

    const url = `/services/data/v${apiVersion}/tooling/query?q=${encodeURIComponent(query)}`;
    let result;
    if (isSource) {
      result = await restForOrg(orgHost, token, url);
    } else {
      result = await sfConn.rest(url);
    }

    const channels = [...initial];
    (result.records || []).forEach(rec => {
      const name = rec.QualifiedApiName || rec.FullName || rec.SelectedEntity || rec.EntityName;
      const label = rec.SelectedEntity
        ? rec.SelectedEntity.replace(/([A-Z])/g, " $1").replace(/__?/g, "__c")
        : rec.Label || rec.MasterLabel || rec.EntityName + " (" + name + ")";
      channels.push({name, label});
    });
    return channels;
  }

  // ── CometD subscription ──────────────────────────────────────────────────────

  buildChannelPath() {
    const {model} = this.props;
    if (model.customChannelPath) return model.customChannelPath;
    const type = CHANNEL_TYPES.find(t => t.value === model.selectedChannelType);
    return type ? type.prefix + model.selectedChannel : "";
  }

  async onSubscribe() {
    const {model} = this.props;
    if (model.replayId == -2 && !model.popConfirmed) {
      model.showReplayWarning = true;
      model.didUpdate();
      return;
    }

    model.channelError = "";
    model.isListening = true;
    model.spinnerCount++;
    model.didUpdate();

    const isSource = !!model.selectedSourceOrgHost;
    const orgHost = isSource ? model.selectedSourceOrgHost : model.sfHost;
    const orgToken = isSource ? getSourceOrgToken(orgHost) : model.sessionId;
    const channelPath = this.buildChannelPath();

    const cometd = new CometD();
    const isFirefox = getBrowserType() === "moz";
    cometd.configure({
      url: `https://${orgHost}/cometd/${apiVersion}`,
      requestHeaders: {Authorization: "Bearer " + orgToken},
      appendMessageTypeToURL: false,
      ...(isFirefox && {useWorkerScheduler: false})
    });
    cometd.websocketEnabled = false;

    const replay = new CometdReplayExtension();
    replay.setChannel(channelPath);
    replay.setReplay(model.replayId);
    cometd.registerExtension("SalesforceReplayExtension", replay);

    // Reconnect on connection loss
    cometd.addListener("/meta/connect", msg => {
      if (!msg.successful && model.isListening) {
        this.scheduleReconnect(channelPath);
      } else if (msg.successful && model.reconnectAttempt > 0) {
        model.reconnectAttempt = 0;
        clearTimeout(model.reconnectTimer);
        model.channelListening = "Listening on " + channelPath + " ...";
        model.didUpdate();
      }
    });

    cometd.handshake(handshakeReply => {
      if (handshakeReply.successful) {
        model.cometd = cometd;
        model.subscription = cometd.subscribe(
          channelPath,
          message => this.onEventReceived(message, channelPath),
          subReply => {
            if (subReply.successful) {
              model.channelListening = "Listening on " + channelPath + " ...";
            } else {
              model.channelError = "Subscribe error: " + subReply.error;
              model.isListening = false;
            }
            model.spinnerCount--;
            model.didUpdate();
          }
        );
      } else {
        model.channelError = "Handshake failed: " + (handshakeReply.error || JSON.stringify(handshakeReply));
        model.isListening = false;
        model.spinnerCount--;
        model.didUpdate();
      }
    });
  }

  scheduleReconnect(channelPath) {
    const {model} = this.props;
    clearTimeout(model.reconnectTimer);
    const delay = BACKOFF[Math.min(model.reconnectAttempt, BACKOFF.length - 1)];
    const attempt = model.reconnectAttempt + 1;
    model.reconnectAttempt = attempt;
    model.channelListening = `Reconnecting (attempt ${attempt})…`;
    model.didUpdate();

    model.reconnectTimer = setTimeout(async () => {
      if (!model.isListening) return;
      // Disconnect and re-subscribe
      if (model.cometd) {
        try { model.cometd.disconnect(() => {}); } catch {}
        model.cometd = null;
      }
      await this.onSubscribe();
    }, delay);
  }

  onEventReceived(message, channelPath) {
    const {model} = this.props;
    const data = message.data;
    if (!data?.event?.replayId) return;
    if (model.events.some(e => e.event?.replayId === data.event.replayId)) return;

    const sourceOrg = model.getSelectedSourceOrg();
    const record = {
      ...data,
      _time: fmtTime(new Date()),
      _sourceOrg: sourceOrg ? (sourceOrg.name || sourceOrg.sfHost) : null,
      _publishStatus: null   // null | "pending" | "success" | "failed"
    };
    model.events.unshift(record);
    model.didUpdate();

    // Publish to current org if enabled
    if (model.publishToCurrentOrg && model.selectedChannel?.endsWith("__e")) {
      record._publishStatus = "pending";
      model.isPublishing = true;
      model.didUpdate();

      publishToCurrentOrg(model.selectedChannel, data.payload)
        .then(() => {
          record._publishStatus = "success";
          model.publishedCount++;
          model.isPublishing = false;
          model.didUpdate();
        })
        .catch(() => {
          record._publishStatus = "failed";
          model.isPublishing = false;
          model.didUpdate();
        });
    }

    if (window.Prism) setTimeout(() => window.Prism.highlightAll(), 0);
  }

  onUnsubscribe() {
    const {model} = this.props;
    clearTimeout(model.reconnectTimer);
    if (model.cometd) {
      if (model.subscription) model.cometd.unsubscribe(model.subscription, () => {});
      model.cometd.disconnect(() => {
        model.channelListening = "";
        model.isListening = false;
        model.reconnectAttempt = 0;
        model.didUpdate();
      });
    } else {
      model.channelListening = "";
      model.isListening = false;
      model.reconnectAttempt = 0;
      model.didUpdate();
    }
  }

  // ── Source org connect ────────────────────────────────────────────────────────

  getConnectOrgHost() {
    const {model} = this.props;
    if (model.connectOrgType === "production") return "login.salesforce.com";
    if (model.connectOrgType === "sandbox") return "test.salesforce.com";
    return model.connectOrgCustomHost;
  }

  loadConnectOrgClientId() {
    const {model} = this.props;
    const orgHost = this.getConnectOrgHost();
    model.connectOrgClientId = orgHost ? localStorage.getItem(orgHost + Constants.CLIENT_ID) || "" : "";
  }

  onConnectOrgClick() {
    const {model} = this.props;
    model.showConnectDialog = true;
    model.connectOrgError = "";
    model.connectOrgLoading = false;
    this.loadConnectOrgClientId();
    model.didUpdate();
  }

  onConnectOrgTypeChange(e) {
    const {model} = this.props;
    model.connectOrgType = e.target.value;
    this.loadConnectOrgClientId();
    model.didUpdate();
  }

  onConnectOrgCustomHostInput(e) {
    const {model} = this.props;
    model.connectOrgCustomHost = e.target.value.trim().replace(/^https?:\/\//, "");
    this.loadConnectOrgClientId();
    model.didUpdate();
  }

  onConnectOrgClientIdInput(e) {
    const {model} = this.props;
    model.connectOrgClientId = e.target.value.trim();
    model.didUpdate();
  }

  onCopyConnectCallback() {
    const {model} = this.props;
    copyToClipboard(model.connectOrgCallbackUri);
    model.didUpdate();
  }

  async onConfirmConnect() {
    const {model} = this.props;
    const orgHost = this.getConnectOrgHost();

    if (!orgHost) {
      model.connectOrgError = "Please enter a Salesforce host.";
      model.didUpdate();
      return;
    }

    model.connectOrgLoading = true;
    model.connectOrgError = "";
    model.didUpdate();

    try {
      const customClientId = model.connectOrgClientId.trim();
      if (customClientId) {
        localStorage.setItem(orgHost + Constants.CLIENT_ID, customClientId);
      } else {
        localStorage.removeItem(orgHost + Constants.CLIENT_ID);
      }
      await initiateSourceOrgOAuth(orgHost, model.sfHost);
    } catch (err) {
      model.connectOrgError = err.message || String(err);
      model.connectOrgLoading = false;
      model.didUpdate();
      return;
    }

    // Window.opener postMessage will fire when OAuth completes
    model.connectOrgLoading = false;
    model.showConnectDialog = false;
    model.didUpdate();
  }

  onCancelConnect() {
    const {model} = this.props;
    model.showConnectDialog = false;
    model.connectOrgError = "";
    model.connectOrgLoading = false;
    model.didUpdate();
  }

  async finalizeSourceOrgConnect(sfHost) {
    const {model} = this.props;
    // Fetch org name from newly connected org
    let name = sfHost;
    try {
      const token = getSourceOrgToken(sfHost);
      if (token) {
        const res = await restForOrg(sfHost, token, `/services/data/v${apiVersion}/query/?q=SELECT+Name,IsSandbox+FROM+Organization`);
        const org = res.records?.[0];
        if (org) name = org.Name;
      }
    } catch {}

    await saveSourceOrg({sfHost, name});
    await model.loadSourceOrgs();
    model.selectedSourceOrgHost = sfHost;
    model.channelCache = {};   // refresh channel list for new source org
    model.didUpdate();
    this.loadChannels();
  }

  async onRemoveSourceOrg() {
    const {model} = this.props;
    const host = model.selectedSourceOrgHost;
    if (!host) return;
    if (model.isListening) this.onUnsubscribe();
    await removeSourceOrg(host);
    await model.loadSourceOrgs();
    model.selectedSourceOrgHost = "";
    model.channelCache = {};
    model.didUpdate();
    this.loadChannels();
  }

  // ── Publish to current org ────────────────────────────────────────────────────

  onPublishCheckboxChange(e) {
    const {model} = this.props;
    model.publishToCurrentOrg = e.target.checked;
    model.didUpdate();
  }

  // ── Generate event ────────────────────────────────────────────────────────────

  async onGenerateClick() {
    const {model} = this.props;
    model.showGenerateDialog = true;
    model.generatePayload = "";
    model.generateError = "";
    model.generateLoading = true;
    model.didUpdate();
    await this.fetchDescribeAndGenerate();
  }

  async fetchDescribeAndGenerate() {
    const {model} = this.props;
    if (model.generateDescribeChannel === model.selectedChannel && model.generateDescribeFields) {
      this.buildGeneratedPayload();
      return;
    }
    try {
      const desc = await sfConn.rest(`/services/data/v${apiVersion}/sobjects/${model.selectedChannel}/describe`);
      model.generateDescribeFields = desc.fields || [];
      model.generateDescribeChannel = model.selectedChannel;
    } catch (err) {
      model.generateError = err.message || String(err);
    }
    model.generateLoading = false;
    model.didUpdate();
    this.buildGeneratedPayload();
  }

  buildGeneratedPayload() {
    const {model} = this.props;
    if (!model.generateDescribeFields) return;
    const isPE = (model.selectedChannel || "").endsWith("__e");
    const payload = {};
    for (const f of model.generateDescribeFields) {
      if (f.name === "Id" || f.calculated) continue;
      if (!f.createable && !(isPE && f.name.endsWith("__c"))) continue;
      const v = generateRandomValue(f);
      if (v !== undefined) payload[f.name] = v;
    }
    model.generatePayload = JSON.stringify(payload, null, 2);
    model.generateLoading = false;
    model.didUpdate();
  }

  onRegeneratePayload() { this.buildGeneratedPayload(); }

  onGeneratePayloadChange(e) {
    const {model} = this.props;
    model.generatePayload = e.target.value;
    model.generateError = "";
    model.didUpdate();
  }

  async onConfirmGenerate() {
    const {model} = this.props;
    model.generateError = "";
    model.generateLoading = true;
    model.didUpdate();
    try {
      const payload = JSON.parse(model.generatePayload || "{}");
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("Payload must be a JSON object");
      await sfConn.rest(`/services/data/v${apiVersion}/sobjects/${model.selectedChannel}`, {method: "POST", body: payload});
      model.eventHistory.add({channel: model.selectedChannel, payload: model.generatePayload, key: Date.now()});
      model.showGenerateDialog = false;
    } catch (err) {
      model.generateError = err.message || String(err);
    }
    model.generateLoading = false;
    model.didUpdate();
  }

  onCancelGenerate() {
    const {model} = this.props;
    model.showGenerateDialog = false;
    model.generateError = "";
    model.generatePayload = "";
    model.generateLoading = false;
    model.didUpdate();
  }

  onSelectHistoryEntry(e) {
    const {model} = this.props;
    const entry = model.eventHistory.list.find(i => String(i.key) === e.target.value);
    if (entry) { model.generatePayload = entry.payload; model.generateError = ""; model.didUpdate(); }
  }

  // ── Replay warning ────────────────────────────────────────────────────────────

  onReplayWarningYes() {
    const {model} = this.props;
    model.popConfirmed = true;
    model.showReplayWarning = false;
    this.onSubscribe();
  }

  onReplayWarningNo() {
    const {model} = this.props;
    model.showReplayWarning = false;
    model.replayId = -1;
    model.didUpdate();
  }

  // ── Channel / filter handlers ─────────────────────────────────────────────────

  onChannelTypeChange(e) {
    const {model} = this.props;
    model.selectedChannelType = e.target.value;
    model.channels = [];
    model.selectedChannel = "";
    model.didUpdate();
    this.loadChannels();
  }

  onChannelChange(e) {
    const {model} = this.props;
    model.selectedChannel = e.target.value;
    model.popConfirmed = false;
    model.didUpdate();
  }

  onCustomChannelInput(e) {
    const {model} = this.props;
    model.customChannelPath = e.target.value;
    model.didUpdate();
  }

  onReplayIdChange(e) {
    const {model} = this.props;
    model.replayId = e.target.value;
    model.popConfirmed = false;
    model.didUpdate();
  }

  onSourceOrgChange(e) {
    const {model} = this.props;
    if (model.isListening) this.onUnsubscribe();
    model.selectedSourceOrgHost = e.target.value;
    model.channelCache = {};
    model.channels = [];
    model.selectedChannel = "";
    model.publishToCurrentOrg = false;
    model.didUpdate();
    this.loadChannels();
  }

  // ── Event feed handlers ───────────────────────────────────────────────────────

  onSelectEvent(idx) {
    const {model} = this.props;
    if (window.getSelection()?.toString()) return;
    model.selectedEventIndex = idx;
    model.selectedEvent = model.events[idx];
    model.didUpdate();
  }

  onCopyAsJson() {
    const {model} = this.props;
    const visible = model.events.filter(e => !e._hidden);
    const toCopy = model.selectedEvent ? model.selectedEvent : visible;
    const {_hidden, _sourceOrg, _publishStatus, _time, ...clean} = Array.isArray(toCopy)
      ? toCopy.reduce((_, e) => e) // placeholder
      : toCopy;
    copyToClipboard(JSON.stringify(
      Array.isArray(toCopy)
        ? toCopy.map(({_hidden: _h, _sourceOrg: _s, _publishStatus: _p, _time: _t, ...rest}) => rest)
        : {_hidden, _sourceOrg, _publishStatus, _time, ...clean},
      null, 2
    ));
  }

  onClearEvents() {
    const {model} = this.props;
    model.clearEvents();
    model.didUpdate();
  }

  onEventFilterInput(e) {
    const {model} = this.props;
    model.eventFilter = e.target.value.toLowerCase();
    model.events = model.events.map(ev => ({...ev, _hidden: !JSON.stringify(ev).toLowerCase().includes(model.eventFilter)}));
    model.didUpdate();
  }

  onClearFilter() {
    const {model} = this.props;
    model.eventFilter = "";
    model.events = model.events.map(ev => ({...ev, _hidden: false}));
    model.didUpdate();
  }

  onToggleCollapse() {
    const {model} = this.props;
    model.collapsed = !model.collapsed;
    model.didUpdate();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  get canSubscribe() {
    const {model} = this.props;
    return !model.isListening && (!!model.selectedChannel || !!model.customChannelPath);
  }

  get canGenerate() {
    const {model} = this.props;
    return PUBLISHABLE_TYPES.has(model.selectedChannelType) && !model.customChannelPath && !!model.selectedChannel && !model.isListening;
  }

  get showPublishCheckbox() {
    const {model} = this.props;
    return !!model.selectedSourceOrgHost && (model.selectedChannel || "").endsWith("__e") && PUBLISHABLE_TYPES.has(model.selectedChannelType);
  }

  statusClass() {
    const {model} = this.props;
    if (model.reconnectAttempt > 0) return "sem-dot--reconnect";
    if (model.isListening) return "sem-dot--live";
    if (model.channelError) return "sem-dot--error";
    return "sem-dot--idle";
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  render() {
    const {model} = this.props;
    const visible = model.events.filter(e => !e._hidden);
    const isReconnecting = model.reconnectAttempt > 0;

    return h("div", {className: "sem-panel"},

      // ── Header (always visible) ──────────────────────────────────────────────
      h("div", {className: "sem-header"},
        h("span", {className: "sem-header-title"}, "⚡ Event Manager"),
        h("div", {className: "sem-header-indicators"},
          model.isPublishing
            ? h("span", {className: "sem-publish-indicator sem-publish-indicator--active", title: "Publishing event…"}, "↑")
            : model.publishedCount > 0
              ? h("span", {className: "sem-publish-indicator", style: {opacity: 0.7}, title: `${model.publishedCount} events published`}, `↑${model.publishedCount}`)
              : null,
          model.events.length > 0
            ? h("span", {className: "sem-event-badge"}, `${visible.length}/${model.events.length}`)
            : null,
          h("div", {className: `sem-dot ${this.statusClass()}`, title: isReconnecting ? model.channelListening : model.isListening ? "Live" : model.channelError || "Idle"})
        ),
        h("button", {className: "sem-collapse-btn", onClick: this.onToggleCollapse, title: model.collapsed ? "Expand panel" : "Collapse panel"},
          model.collapsed ? "▼" : "▲"
        )
      ),

      // ── Body (collapsible) ───────────────────────────────────────────────────
      h("div", {className: `sem-body${model.collapsed ? " sem-body--hidden" : ""}`},

        // Current org bar
        h("div", {className: "sem-org-bar"},
          h("span", {className: `sem-org-badge${model.isSandbox ? "" : " sem-org-badge--prod"}`},
            model.isSandbox ? "Sandbox" : "Production"
          ),
          h("span", {className: "sem-org-name", title: model.sfHost}, model.orgName || model.sfHost)
        ),

        // ── Source Org section ────────────────────────────────────────────────
        h("div", {className: "sem-section"},
          h("div", {className: "sem-section-title"}, "Source Org"),
          h("div", {className: "sem-row"},
            h("select", {
              className: "sem-select",
              value: model.selectedSourceOrgHost,
              onChange: this.onSourceOrgChange,
              disabled: model.isListening
            },
            h("option", {value: ""}, "Current Org"),
            ...model.sourceOrgs.map(o =>
              h("option", {key: o.sfHost, value: o.sfHost}, o.name || o.sfHost)
            )
            ),
            h("button", {className: "sem-btn sem-btn--neutral", onClick: this.onConnectOrgClick, disabled: model.isListening, title: "Connect a source org"}, "+"),
            model.selectedSourceOrgHost
              ? h("button", {className: "sem-btn sem-btn--icon", onClick: this.onRemoveSourceOrg, title: "Remove this source org"}, "✕")
              : null
          )
        ),

        // ── Subscribe section ─────────────────────────────────────────────────
        h("div", {className: "sem-section"},
          h("div", {className: "sem-section-title"}, "Subscribe"),
          h("div", {className: "sem-row"},
            h("label", {className: "sem-label"}, "Type"),
            h("select", {
              className: "sem-select",
              value: model.selectedChannelType,
              onChange: this.onChannelTypeChange,
              disabled: model.isListening
            },
            ...CHANNEL_TYPES.map(t => h("option", {key: t.value, value: t.value}, t.label))
            )
          ),
          h("div", {className: "sem-row"},
            h("label", {className: "sem-label"}, "Channel"),
            h("select", {
              className: "sem-select",
              value: model.selectedChannel,
              onChange: this.onChannelChange,
              disabled: model.isListening
            },
            model.spinnerCount > 0
              ? h("option", {}, "Loading…")
              : model.channels.map(c => h("option", {key: c.name, value: c.name || ""}, c.label))
            )
          ),
          h("div", {className: "sem-row"},
            h("label", {className: "sem-label"}, "Custom"),
            h("input", {
              className: "sem-input",
              value: model.customChannelPath,
              onChange: this.onCustomChannelInput,
              disabled: model.isListening,
              placeholder: "/event/MyEvent"
            })
          ),
          h("div", {className: "sem-row"},
            h("label", {className: "sem-label"}, "Replay"),
            h("input", {
              className: "sem-input",
              type: "number",
              value: model.replayId,
              onChange: this.onReplayIdChange,
              disabled: model.isListening,
              style: {maxWidth: "72px"}
            }),
            h("div", {className: "sem-btn-group"},
              h("button", {className: "sem-btn sem-btn--primary", onClick: this.onSubscribe, disabled: !this.canSubscribe}, "Sub"),
              h("button", {className: "sem-btn sem-btn--neutral", onClick: this.onUnsubscribe, disabled: !model.isListening}, "Stop"),
              this.canGenerate
                ? h("button", {className: "sem-btn sem-btn--neutral", onClick: this.onGenerateClick, title: "Generate & publish event"}, "Gen")
                : null
            )
          ),

          // Publish to current org checkbox
          this.showPublishCheckbox
            ? h("label", {className: "sem-checkbox-row"},
                h("input", {type: "checkbox", checked: model.publishToCurrentOrg, onChange: this.onPublishCheckboxChange}),
                h("span", {}, "Republish to current org")
              )
            : null
        ),

        // ── Status bar ────────────────────────────────────────────────────────
        model.channelListening || model.channelError
          ? h("div", {className: "sem-statusbar"},
              isReconnecting
                ? h("span", {className: "sem-status-reconnect"}, "↺ " + model.channelListening)
                : model.channelError
                  ? h("span", {className: "sem-status-error"}, "✕ " + model.channelError)
                  : h("span", {className: "sem-status-live"}, "● " + model.channelListening)
            )
          : null,

        // ── Event feed ────────────────────────────────────────────────────────
        h("div", {className: "sem-feed"},
          h("div", {className: "sem-feed-toolbar"},
            h("input", {
              className: "sem-input",
              placeholder: "Filter…",
              value: model.eventFilter,
              onChange: this.onEventFilterInput,
              disabled: model.events.length === 0
            }),
            model.eventFilter
              ? h("button", {className: "sem-btn sem-btn--icon", onClick: this.onClearFilter}, "✕")
              : null,
            h("span", {className: "sem-feed-count"}, `${visible.length}`),
            h("button", {className: "sem-btn sem-btn--icon", onClick: this.onCopyAsJson, disabled: visible.length === 0, title: "Copy as JSON"}, "⎘"),
            h("button", {className: "sem-btn sem-btn--icon", onClick: this.onClearEvents, disabled: model.events.length === 0, title: "Clear"}, "🗑")
          ),

          h("div", {className: "sem-feed-list"},
            visible.length === 0
              ? h("div", {style: {padding: "16px 10px", color: "#9ca3af", fontSize: "11px", textAlign: "center"}},
                  model.isListening ? "Waiting for events…" : "No events. Subscribe to a channel."
                )
              : visible.map((ev, idx) => {
                const {_hidden, _sourceOrg, _publishStatus, _time, ...eventData} = ev;
                return h("div", {
                  key: ev.event?.replayId ?? idx,
                  className: `sem-event${model.selectedEventIndex === idx ? " sem-event--selected" : ""}`,
                  onClick: () => this.onSelectEvent(idx)
                },
                h("pre", {className: "language-json"}, JSON.stringify(eventData, null, 2)),
                h("div", {className: "sem-event-meta"},
                  _time ? h("span", {style: {fontSize: "10px", color: "#9ca3af"}}, _time) : null,
                  _sourceOrg ? h("span", {className: "sem-tag sem-tag--source"}, _sourceOrg) : null,
                  _publishStatus === "success" ? h("span", {className: "sem-tag sem-tag--success"}, "✓ Published") : null,
                  _publishStatus === "failed"  ? h("span", {className: "sem-tag sem-tag--failed"},  "✕ Failed")   : null,
                  _publishStatus === "pending" ? h("span", {className: "sem-tag sem-tag--pending"}, "↑ Publishing…") : null
                )
                );
              })
          )
        )
      ),

      // ── Replay -2 warning modal ────────────────────────────────────────────
      h(ConfirmModal, {
        isOpen: model.showReplayWarning,
        title: "Replay from beginning",
        onConfirm: this.onReplayWarningYes,
        onCancel: this.onReplayWarningNo,
        confirmLabel: "Subscribe",
        cancelLabel: "Cancel",
        confirmVariant: model.isSandbox ? "brand" : "destructive"
      },
      model.isSandbox ? null : h("div", {className: "sem-alert sem-alert--error", style: {marginBottom: 8}}, "⚠ You are on a PRODUCTION org."),
      h("p", {style: {fontSize: "12px"}}, "Replaying from the beginning (-2) can be slow and may consume your daily event limit.")
      ),

      // ── Connect org modal ──────────────────────────────────────────────────
      h(ConfirmModal, {
        isOpen: model.showConnectDialog,
        title: "Connect Source Org",
        onConfirm: this.onConfirmConnect,
        onCancel: this.onCancelConnect,
        confirmLabel: model.connectOrgLoading ? "Connecting…" : "Connect",
        cancelLabel: "Cancel",
        confirmVariant: "brand",
        confirmDisabled: model.connectOrgLoading
      },
      h("div", {className: "sem-radio-group"},
        ["production", "sandbox", "custom"].map(type =>
          h("label", {key: type, className: "sem-radio-row"},
            h("input", {type: "radio", name: "orgType", value: type, checked: model.connectOrgType === type, onChange: this.onConnectOrgTypeChange}),
            type === "production" ? "Production (login.salesforce.com)"
              : type === "sandbox" ? "Sandbox (test.salesforce.com)"
              : "Custom domain"
          )
        )
      ),
      model.connectOrgType === "custom"
        ? h("input", {
            className: "sem-input sem-input-full",
            style: {marginBottom: 8},
            placeholder: "myorg.my.salesforce.com",
            value: model.connectOrgCustomHost,
            onChange: this.onConnectOrgCustomHostInput
          })
        : null,
      h("div", {className: "sem-field"},
        h("label", {className: "sem-field-label"}, "Consumer Key"),
        h("input", {
          className: "sem-input sem-input-full",
          placeholder: "Use default connected app",
          value: model.connectOrgClientId,
          onChange: this.onConnectOrgClientIdInput,
          disabled: model.connectOrgLoading
        })
      ),
      h("div", {className: "sem-field"},
        h("label", {className: "sem-field-label"}, "Callback URL"),
        h("div", {className: "sem-inline-input"},
          h("input", {
            className: "sem-input",
            value: model.connectOrgCallbackUri,
            readOnly: true
          }),
          h("button", {
            className: "sem-btn sem-btn--neutral",
            type: "button",
            onClick: this.onCopyConnectCallback,
            disabled: model.connectOrgLoading
          }, "Copy")
        )
      ),
      model.connectOrgError
        ? h("div", {className: "sem-alert sem-alert--error"}, model.connectOrgError)
        : null,
      h("p", {style: {fontSize: "11px", color: "#6b7280", margin: "8px 0 0"}},
        "A browser window will open to authorize the connection."
      )
      ),

      // ── Generate event modal ───────────────────────────────────────────────
      h(ConfirmModal, {
        isOpen: model.showGenerateDialog,
        title: `Publish to: ${model.selectedChannel || ""}`,
        onConfirm: this.onConfirmGenerate,
        onCancel: this.onCancelGenerate,
        onCopy: this.onRegeneratePayload,
        confirmLabel: model.generateLoading ? "Publishing…" : "Publish",
        cancelLabel: "Cancel",
        copyLabel: "Regenerate",
        confirmVariant: model.isSandbox ? "brand" : "destructive",
        confirmDisabled: model.generateLoading || !model.generatePayload,
        copyDisabled: model.generateLoading,
        modalSize: "medium"
      },
      !model.isSandbox
        ? h("div", {className: "sem-alert sem-alert--error", style: {marginBottom: 8}}, "⚠ Production org — publish with care.")
        : null,
      model.eventHistory.list.length > 0
        ? h("div", {style: {marginBottom: 8}},
            h("select", {className: "sem-select", style: {width: "100%"}, onChange: this.onSelectHistoryEntry, defaultValue: ""},
              h("option", {value: "", disabled: true}, "History"),
              model.eventHistory.list.map(e => h("option", {key: e.key, value: String(e.key)},
                e.payload.slice(0, 80) + (e.payload.length > 80 ? "…" : "")
              ))
            )
          )
        : null,
      model.generateLoading && !model.generatePayload
        ? h("div", {style: {padding: "12px", textAlign: "center", color: "#6b7280", fontSize: "12px"}}, "Loading fields…")
        : null,
      model.generatePayload
        ? h("textarea", {
            className: "sem-payload-textarea",
            value: model.generatePayload,
            onChange: this.onGeneratePayloadChange,
            disabled: model.generateLoading
          })
        : null,
      model.generateError
        ? h("div", {className: "sem-alert sem-alert--error", style: {marginTop: 6}}, model.generateError)
        : null
      )
    );
  }
}

// ─── CometD replay extension ──────────────────────────────────────────────────

function CometdReplayExtension() {
  let _cometd, _enabled, _replay, _channel;
  this.setReplay = r => { _replay = parseInt(r, 10); };
  this.setChannel = c => { _channel = c; };
  this.registered = (_, c) => { _cometd = c; void _cometd; };
  this.incoming = msg => {
    if (msg.channel === "/meta/handshake" && msg.ext?.replay === true) _enabled = true;
    else if (msg.channel === _channel && msg.data?.event?.replayId) _replay = msg.data.event.replayId;
  };
  this.outgoing = msg => {
    if (msg.channel === "/meta/subscribe" && _enabled) {
      if (!msg.ext) msg.ext = {};
      msg.ext.replay = {[_channel]: _replay};
    }
  };
}

// ─── Initialisation ───────────────────────────────────────────────────────────

let globalModel = null;
let globalRoot = null;

function renderPanel(model) {
  globalModel = model;
  model.reactCallback = cb => ReactDOM.render(h(App, {model}), globalRoot, cb);
  ReactDOM.render(h(App, {model}), globalRoot);
}

function renderNoOrg() {
  ReactDOM.render(
    h("div", {className: "sem-panel"},
      h("div", {className: "sem-header"},
        h("span", {className: "sem-header-title"}, "⚡ Event Manager"),
        h("div", {className: "sem-dot sem-dot--idle"})
      ),
      h("div", {className: "sem-no-org"},
        h("div", {className: "sem-no-org-icon"}, "⚡"),
        h("div", {className: "sem-no-org-text"}, "Navigate to a Salesforce org to start monitoring events.")
      )
    ),
    globalRoot
  );
}

async function initPanel(sfHost) {
  if (!sfHost) { renderNoOrg(); return; }

  try {
    await sfConn.getSession(sfHost);
  } catch {
    renderNoOrg();
    return;
  }

  if (globalModel && globalModel.sfHost === sfHost) {
    // Same org — just update the session in case token changed
    globalModel.sessionId = sfConn.sessionId;
    globalModel.didUpdate();
    return;
  }

  const model = new Model(sfHost, sfConn.sessionId);
  // Preserve subscription state across re-renders if same model
  renderPanel(model);
}

// Listen for tab-change broadcasts from background
chrome.runtime.onMessage.addListener((request) => {
  if (request.message === "sfHostChanged" && request.sfHost) {
    const newHost = request.sfHost;
    if (globalModel && globalModel.sfHost !== newHost) {
      // Update current org display without killing an active subscription
      globalModel.sfHost = newHost;
      globalModel.sfLink = "https://" + newHost;
      globalModel.orgName = newHost.split(".")[0]?.toUpperCase() || "";
      globalModel.isSandbox = localStorage.getItem(newHost + "_isSandbox") === "true";
      // Refresh session for new org (silently)
      sfConn.getSession(newHost).then(() => {
        if (globalModel) globalModel.sessionId = sfConn.sessionId;
        globalModel.didUpdate();
      }).catch(() => {});
    } else if (!globalModel) {
      initPanel(newHost);
    }
  }
});

// Startup: ask background for current Salesforce tab's sfHost
globalRoot = document.getElementById("root");

chrome.runtime.sendMessage({message: "getCurrentSfHost"}, response => {
  const sfHost = response?.sfHost || null;
  initPanel(sfHost);
});
