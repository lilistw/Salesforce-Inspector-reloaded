import {sfConn} from "./inspector.js";

// This page exists solely as the OAuth redirect_uri for PKCE flows.
// inspector.js getSession() reads the ?code= and ?state= params, exchanges
// the code for a token, and — for source org connections — posts a message
// to the opener and closes this window automatically.
(async () => {
  const params = new URLSearchParams(window.location.search);
  const sfHost = params.get("host") || "";
  await sfConn.getSession(sfHost);
})();
