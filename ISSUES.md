P2: npm audit reports a moderate ws vulnerability via Baileys.

baileys@7.0.0-rc.9 pulls ws@8.19.0 in package-lock.json (line 3484). Audit says ws has GHSA-58qx-3vcg-4xpx and npm audit fix is available. Worth doing before a public-ish test deploy.
