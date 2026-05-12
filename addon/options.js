/* global React ReactDOM */
import {defaultApiVersion} from "./inspector.js";

const h = React.createElement;

const DONATE_URL = "https://github.com/sponsors/tprouvot";
const ATTRIBUTION_URL = "https://github.com/tprouvot/Salesforce-Inspector-reloaded";

function Section({title, children}) {
  return h("div", {className: "opt-card"},
    h("div", {className: "opt-card-title"}, title),
    children
  );
}

function Row({label, hint, control}) {
  return h("div", {className: "opt-row"},
    h("div", {className: "opt-label"},
      label,
      hint ? h("small", null, hint) : null
    ),
    control
  );
}

class OptionsApp extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      apiVersionValue: localStorage.getItem("apiVersion") || defaultApiVersion,
      saved: false,
    };
  }

  save() {
    const v = this.state.apiVersionValue.trim();
    if (!v) return;
    localStorage.setItem("apiVersion", v);
    this.setState({saved: true});
    setTimeout(() => this.setState({saved: false}), 2000);
  }

  render() {
    const {apiVersionValue, saved} = this.state;

    return h("div", null,

      h(Section, {title: "API"},
        h(Row, {
          label: "API Version",
          hint: `Default: ${defaultApiVersion}`,
          control: h("div", {style: {display: "flex", gap: 6, alignItems: "center"}},
            h("input", {
              className: "opt-input",
              value: apiVersionValue,
              onChange: e => this.setState({apiVersionValue: e.target.value}),
              onKeyDown: e => e.key === "Enter" && this.save(),
              style: {width: 100},
            }),
            h("button", {className: "opt-btn opt-btn--primary", onClick: () => this.save()}, "Save"),
            saved ? h("span", {className: "opt-saved"}, "Saved") : null
          )
        })
      ),

      h(Section, {title: "About"},
        h("div", {className: "opt-about-text"},
          "Salesforce Event Manager — built on ",
          h("a", {href: ATTRIBUTION_URL, target: "_blank", rel: "noopener"}, "Salesforce Inspector Reloaded"),
          " (MIT License) by Thomas Prouvot and contributors."
        ),
        h("div", {className: "opt-donate-row"},
          h("a", {className: "opt-donate-btn", href: DONATE_URL, target: "_blank", rel: "noopener"},
            "Support the project"
          )
        )
      )
    );
  }
}

ReactDOM.render(h(OptionsApp, null), document.getElementById("root"));
