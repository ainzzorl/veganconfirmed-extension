// Regression: a Maps URL can carry several place ids, because Maps retains the
// previously viewed place as context in the `data=` blob. Real URLs reported
// from the field, where taking the FIRST id served Clara's Junction's cached
// menu while viewing a different address.
const assert = require("assert");
const path = require("path");
const { JSDOM } = require("jsdom");

const dom = new JSDOM("<body></body>", { url: "https://www.google.com/maps/" });
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.MutationObserver = dom.window.MutationObserver;

const maps = require(path.resolve(__dirname, "..", "maps.js"));

const CLARAS_ID = "0x808fc9a60ac86f1f:0x6dc4cce51a6c31ed";
const AVENIDA_ID = "0x808fc9afe928fbc5:0xb37f114722e5025c";

// Viewing Clara's Junction: the blob repeats the same id twice.
const CLARAS_URL =
  "https://www.google.com/maps/place/Clara's+Junction/@37.4078805,-121.9664061,17z/" +
  "data=!4m16!1m8!3m7!1s" + CLARAS_ID + "!2sClara's+Junction!8m2!3d37.4078763!4d-121.9638312" +
  "!10e9!16s%2Fg%2F11lp82svwn!3m6!1s" + CLARAS_ID + "!8m2!3d37.4078763!4d-121.9638312" +
  "!10e9!16s%2Fg%2F11lp82svwn?entry=ttu&g_ep=EgoyMDI2MDgwOS4wIKXMDSoASAFQAw%3D%3D";

// Then navigating to a nearby address: Clara's id is STILL first in the blob
// (with !2sClara's+Junction), and the address's own id is last.
const AVENIDA_URL =
  "https://www.google.com/maps/place/4909+Avenida+De+Lago,+Santa+Clara,+CA+95054/" +
  "@37.4063168,-121.9603844,17z/data=!4m14!1m7!3m6!1s" + CLARAS_ID +
  "!2sClara's+Junction!8m2!3d37.4078763!4d-121.9638312!16s%2Fg%2F11lp82svwn" +
  "!3m5!1s" + AVENIDA_ID + "!8m2!3d37.4063168!4d-121.9578095!16s%2Fg%2F11c14g5qds" +
  "?entry=ttu&g_ep=EgoyMDI2MDgwOS4wIKXMDSoASAFQAw%3D%3D";

assert.strictEqual(maps.getPlaceKey(CLARAS_URL), CLARAS_ID);
console.log("Clara's Junction ->", maps.getPlaceKey(CLARAS_URL));

const avenidaKey = maps.getPlaceKey(AVENIDA_URL);
console.log("4909 Avenida     ->", avenidaKey);
assert.notStrictEqual(avenidaKey, CLARAS_ID,
  "REGRESSION: the address resolves to Clara's Junction's id — cache would serve the wrong menu");
assert.strictEqual(avenidaKey, AVENIDA_ID);

// The two places must never share a cache key.
assert.notStrictEqual(maps.getPlaceKey(CLARAS_URL), maps.getPlaceKey(AVENIDA_URL));

// Panning must still not change the key (the original reason for using the id).
assert.strictEqual(
  maps.getPlaceKey(AVENIDA_URL.replace("@37.4063168,-121.9603844,17z", "@37.4099,-121.9500,15z")),
  AVENIDA_ID
);

// A global regex must not carry lastIndex between calls.
for (let i = 0; i < 3; i += 1) {
  assert.strictEqual(maps.getPlaceKey(AVENIDA_URL), AVENIDA_ID, `call ${i} differs`);
}
console.log("repeated calls stable (no regex lastIndex leak)");

// Fallbacks still work.
assert.strictEqual(
  maps.getPlaceKey("https://www.google.com/maps/place/Cafe+Verde"), "name:Cafe Verde");
assert.strictEqual(maps.getPlaceKey("https://www.google.com/maps/@37.4,-121.9,12z"), null);
assert.strictEqual(
  maps.getPlaceKey("https://www.google.com/maps/place/X/data=!1sfoo"), "name:X");

// ChIJ ids, and mixed forms, still take the last.
assert.strictEqual(
  maps.getPlaceKey("https://www.google.com/maps/place/X/data=!1s" + CLARAS_ID +
    "!3m5!1sChIJN1t_tDeuEmsRUsoyG83frY4"),
  "chijn1t_tdeuemsrusoyg83fry4");
console.log("fallbacks + ChIJ form OK");

console.log("\nPLACE KEY REGRESSION TEST PASSED");
process.exit(0);
