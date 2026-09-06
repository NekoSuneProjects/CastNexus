"use strict";

const path = require("node:path");
const express = require("express");
const router = express.Router();

router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "setup.html"));
});

module.exports = router;
