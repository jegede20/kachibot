/** Render the three sample cards (reference values) for side-by-side review. */
const fs = require('fs');
const { renderSampleCard } = require('../dist/card/sample');
const out = { bull: 'kachibot-card-bullish.png', bear: 'kachibot-card-bearish.png', overall: 'kachibot-card-overall.png' };
(async () => {
  for (const [kind, file] of Object.entries(out)) {
    const png = await renderSampleCard(kind);
    fs.writeFileSync(file, png);
    console.log(file, png.length, 'bytes');
  }
})();
