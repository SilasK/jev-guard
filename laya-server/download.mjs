import { Laya } from "@receptron/laya";
console.log("loading Laya (downloads ~1.7GB on first run)...");
const t0 = Date.now();
const laya = await Laya.load({
  onProgress: ({ file, received, total }) => {
    if (total) process.stdout.write(`\r${file} ${(received/1e6).toFixed(1)}/${(total/1e6).toFixed(1)} MB   `);
  },
});
console.log(`\nloaded in ${((Date.now()-t0)/1000).toFixed(1)}s from ${laya.modelDir}`);
console.log("config:", JSON.stringify(laya.config));
await laya.close();
