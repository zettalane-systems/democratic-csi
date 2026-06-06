// ZettaLane packaging overlay — a trimmed factory for Zettalane products
// Keep the case list in sync with controller-zettalane.
const { ControllerZettalaneDriver } = require("./controller-zettalane");

function factory(ctx, options) {
  switch (options.driver) {
    case "mayanas":
    case "mayascale":
    case "mayanas-lustre":
      return new ControllerZettalaneDriver(ctx, options);
    default:
      throw new Error("invalid csi driver: " + options.driver);
  }
}

module.exports.factory = factory;
