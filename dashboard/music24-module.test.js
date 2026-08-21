"use strict";

const assert = require("node:assert/strict");
const music24 = require("./music24");

assert.equal(typeof music24.startMusic24, "function");
assert.equal(typeof music24.shutdown, "function");
assert.equal(typeof music24.Music24Worker, "function");
assert.equal(typeof music24.waitForMediaPath, "function");

// Importing the module for Desktop must not auto-start its polling loop. If it
// did, this test process would retain the interval and hang.
console.log("Music 24/7 embeddable module test passed");
