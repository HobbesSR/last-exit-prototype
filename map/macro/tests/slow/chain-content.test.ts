import test from "node:test";
import { checkGameLayouts, SIZES } from "../chain-content-fixture.ts";

for (const size of SIZES.slice(1))
  test(`${size.name} game layouts place every class's quota, prove connected, and keep each core element class to its own instance`, () =>
    checkGameLayouts(size));
