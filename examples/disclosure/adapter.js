// Appended to Elm's classic-script output by scripts/build-disclosure.ts.
(function () {
  const program = Elm.Main;

  function attributes(element) {
    const result = {};
    for (const attribute of element.attributes) {
      result[attribute.name] = attribute.value;
    }
    return result;
  }

  class UiDisclosure extends HTMLElement {
    static observedAttributes = ["label", "disabled"];

    connectedCallback() {
      if (this.app) return;

      const root = this.attachShadow({ mode: "open" });
      const mount = document.createElement("div");
      root.append(mount);

      this.app = program.init({ node: mount, flags: attributes(this) });
      this.app.ports.outputSent.subscribe(({ name, detail }) => {
        this.dispatchEvent(
          new CustomEvent(name, { detail, bubbles: true, composed: true }),
        );
      });
    }

    attributeChangedCallback() {
      if (this.app) {
        this.app.ports.inputChanged.send(attributes(this));
      }
    }
  }

  customElements.define("ui-disclosure", UiDisclosure);
})();
