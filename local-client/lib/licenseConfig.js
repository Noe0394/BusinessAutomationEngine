'use strict';

// The PC client uses a local license key and the Cloudflare Worker only.
module.exports = { LICENSE_KEY: process.env.LICENSE_KEY || '' };
