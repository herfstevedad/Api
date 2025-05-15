const { JSDOM } = require('jsdom');
const { createCanvas } = require('canvas');

// Simulate a browser-like environment
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
});

global.window = dom.window;
global.document = dom.window.document;
global.DOMMatrix = dom.window.DOMMatrix;
global.ImageData = createCanvas(1, 1).getContext('2d').createImageData(1, 1).constructor;
global.Path2D = dom.window.Path2D;

// Export the global objects if needed
module.exports = { window, document };