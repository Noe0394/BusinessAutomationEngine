const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const exclusionList = require('metro-config/src/defaults/exclusionList');

/**
 * Metro configuration
 * https://facebook.github.io/metro/docs/configuration
 *
 * nodejs-mobile-react-native copies a full Node.js project (with its own
 * node_modules) into nodejs-assets/ — Metro must ignore it entirely, or it
 * throws a "Haste module naming collision" error while trying to bundle it
 * as if it were React Native source.
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {
  resolver: {
    blockList: exclusionList([/\/nodejs-assets\/.*/, /\/android\/.*/, /\/ios\/.*/]),
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
