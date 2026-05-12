const SF_DOMAIN_SUFFIXES = [
  ".salesforce.com", ".salesforce-setup.com", ".force.com", ".cloudforce.com",
  ".visualforce.com", ".sfcrmapps.cn", ".sfcrmproducts.cn", ".salesforce.mil",
  ".force.mil", ".cloudforce.mil", ".visualforce.mil", ".crmforce.mil",
  ".force.com.mcas.ms", ".builder.salesforce-experience.com"
];

const COOKIE_DOMAINS = ["salesforce.com", "cloudforce.com", "salesforce.mil", "cloudforce.mil", "sfcrmproducts.cn", "force.com"];

function isSalesforceUrl(url) {
  if (!url || !url.startsWith("https://")) return false;
  try {
    const host = new URL(url).hostname;
    return SF_DOMAIN_SUFFIXES.some(s => host.endsWith(s));
  } catch {
    return false;
  }
}

// sfHost per windowId — updated whenever user activates a Salesforce tab
const windowSfHost = {};

async function resolveSfHost(tab) {
  if (!tab?.url || !isSalesforceUrl(tab.url)) return null;
  return new Promise(resolve => {
    const storeId = tab.cookieStoreId; // undefined in Chrome = default store
    chrome.cookies.get({url: tab.url, name: "sid", storeId}, cookie => {
      if (!cookie || new URL(tab.url).hostname.endsWith(".mcas.ms")) {
        resolve(new URL(tab.url).hostname);
        return;
      }
      const [orgId] = cookie.value.split("!");
      let found = false;
      COOKIE_DOMAINS.forEach(domain => {
        chrome.cookies.getAll({name: "sid", domain, secure: true, storeId}, cookies => {
          if (found) return;
          const match = cookies.find(c => c.value.startsWith(orgId + "!") && c.domain !== "help.salesforce.com");
          if (match) { found = true; resolve(match.domain); }
        });
      });
      // Fallback if no matching org cookie found within 600ms
      setTimeout(() => { if (!found) resolve(new URL(tab.url).hostname); }, 600);
    });
  });
}

async function onTabActivated(tabId, windowId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const sfHost = await resolveSfHost(tab);
    if (sfHost) {
      windowSfHost[windowId] = sfHost;
      chrome.runtime.sendMessage({message: "sfHostChanged", sfHost}).catch(() => {});
    }
  } catch {
    // Tab may have closed already
  }
}

chrome.tabs.onActivated.addListener(({tabId, windowId}) => {
  onTabActivated(tabId, windowId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.active) return;
  const sfHost = await resolveSfHost(tab);
  if (sfHost && tab.windowId) {
    windowSfHost[tab.windowId] = sfHost;
    chrome.runtime.sendMessage({message: "sfHostChanged", sfHost}).catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).catch(() => {});
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const storeId = sender.tab?.cookieStoreId;

  if (request.message === "getCurrentSfHost") {
    chrome.windows.getCurrent(w => {
      sendResponse({sfHost: windowSfHost[w?.id] || null});
    });
    return true;
  }

  if (request.message === "getSfHost") {
    const currentHostname = new URL(request.url).hostname;
    chrome.cookies.get({url: request.url, name: "sid", storeId}, cookie => {
      if (!cookie || currentHostname.endsWith(".mcas.ms")) {
        sendResponse(currentHostname);
        return;
      }
      const [orgId] = cookie.value.split("!");
      let found = false;
      COOKIE_DOMAINS.forEach(domain => {
        chrome.cookies.getAll({name: "sid", domain, secure: true, storeId}, cookies => {
          if (found) return;
          const match = cookies.find(c => c.value.startsWith(orgId + "!") && c.domain !== "help.salesforce.com");
          if (match) { found = true; sendResponse(match.domain); }
        });
      });
    });
    return true;
  }

  if (request.message === "getSession") {
    chrome.cookies.get({url: "https://" + request.sfHost, name: "sid", storeId}, cookie => {
      if (!cookie) { sendResponse(null); return; }
      sendResponse({key: cookie.value, hostname: cookie.domain});
    });
    return true;
  }

  if (request.message === "tokenUpdated") {
    // Relay token update to side panel (source org OAuth callback)
    chrome.runtime.sendMessage({message: "tokenUpdated", sfHost: request.sfHost}).catch(() => {});
  }

  if (request.message === "createWindow") {
    chrome.windows.create({url: request.url, incognito: request.incognito ?? false, type: "popup", width: 600, height: 700});
  }

  return false;
});

chrome.commands?.onCommand.addListener((command) => {
  if (command === "options") {
    chrome.runtime.openOptionsPage();
  }
});
