const electron = require('electron');
console.log('Type:', typeof electron);
console.log('Is Array:', Array.isArray(electron));
console.log('Constructor:', electron.constructor.name);
console.log('String representation:', String(electron));
console.log('First 20 entries:', Object.entries(electron).slice(0, 20));
