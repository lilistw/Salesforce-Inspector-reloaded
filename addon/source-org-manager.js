import {getPKCEParameters, getClientId, getRedirectUri, Constants} from "./utils.js";

const STORAGE_KEY = "sourceOrgs";

export async function getSourceOrgs() {
  return new Promise(resolve => {
    chrome.storage.local.get(STORAGE_KEY, result => {
      resolve(Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : []);
    });
  });
}

export async function saveSourceOrg(orgData) {
  const orgs = await getSourceOrgs();
  const idx = orgs.findIndex(o => o.sfHost === orgData.sfHost);
  if (idx >= 0) {
    orgs[idx] = {...orgs[idx], ...orgData};
  } else {
    orgs.push(orgData);
  }
  return new Promise(resolve => chrome.storage.local.set({[STORAGE_KEY]: orgs}, resolve));
}

export async function removeSourceOrg(sfHost) {
  const orgs = await getSourceOrgs();
  return new Promise(resolve =>
    chrome.storage.local.set({[STORAGE_KEY]: orgs.filter(o => o.sfHost !== sfHost)}, resolve)
  );
}

export function getSourceOrgToken(sfHost) {
  return localStorage.getItem(sfHost + Constants.ACCESS_TOKEN);
}

export async function initiateSourceOrgOAuth(orgHost, currentOrgHost) {
  const pkceParams = await getPKCEParameters();
  localStorage.setItem(orgHost + Constants.CODE_VERIFIER, pkceParams.code_verifier);

  const redirectUri = getRedirectUri("data-export.html");
  const clientId = getClientId(orgHost);
  const state = encodeURIComponent(JSON.stringify({
    sfHost: orgHost,
    isSourceOrg: true,
    currentOrgHost
  }));

  const authUrl = `https://${orgHost}/services/oauth2/authorize`
    + "?response_type=code"
    + `&client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&code_challenge=${encodeURIComponent(pkceParams.code_challenge)}`
    + "&code_challenge_method=S256"
    + `&state=${state}`;

  chrome.runtime.sendMessage({message: "createWindow", url: authUrl});
}
