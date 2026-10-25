/*
 * KAUSTUBH — Atlas Scheduled Trigger function (06:00 Asia/Kolkata daily wipe).
 *
 * WHAT: deletes ALL documents in the temporary market-data collections so
 * MongoDB Atlas stays a bounded rolling store. Runs Atlas-side, therefore it
 * fires EVEN WHEN the Python backend / VM is offline.
 *
 * DEPLOY (Atlas UI): App Services > Triggers > Add Trigger >
 *   Type: Scheduled | Schedule Type: Cron ->
 *   Cron: "30 0 * * *" (00:30 UTC == 06:00 IST) — see docs/ATLAS_CLEANUP_SETUP.md
 *   Function: paste this whole file.
 * Linked data source: the cluster holding the `kaustubh` database.
 *
 * Collection classification MUST stay in sync with
 * python-service/services/atlas_cleanup.py (TEMPORARY_COLLECTIONS).
 * Everything NOT listed here is preserved (config, summaries, reports,
 * ledgers, session data, and atlas_cleanup_log itself).
 *
 * Each run appends ONE audit doc to `atlas_cleanup_log` (persistent), which
 * the Data Center "Cleanup Status" card reads via GET /api/system/cleanup/status.
 */

const TEMPORARY_COLLECTIONS = [
  "ticks",
  "market_ticks",
  "market_candles_1m",
  "market_candles_5m",
  "market_candles_10m",
  "market_candles_30m",
  "market_watch_decisions",
  "data_saver_telemetry",
  "api_telemetry",
  "websocket_telemetry",
  "websocket_history",
  "websocket_events",
  "quality_snapshot",
  "quality_scans",
  "app_logs",
];

const BATCH_SIZE = 50000;
const MAX_BATCHES = 2000;

exports = async function () {
  const db = context.services
    .get("mongodb-atlas")
    .db(context.values.get("kaustubhDbName") || "kaustubh");

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const perCollection = [];
  let totalDeleted = 0;

  for (const name of TEMPORARY_COLLECTIONS) {
    try {
      const coll = db.collection(name);
      // Chunked _id-range deletes: bounded ops, never one giant blocking op.
      let deleted = 0;
      let lastId = null;
      for (let i = 0; i < MAX_BATCHES; i++) {
        const filter = lastId ? { _id: { $gt: lastId } } : {};
        const batch = await coll.find(filter, { _id: 1 })
          .sort({ _id: 1 }).limit(BATCH_SIZE).toArray();
        if (batch.length === 0) break;
        const ids = batch.map((d) => d._id);
        lastId = ids[ids.length - 1];
        const res = await coll.deleteMany({ _id: { $in: ids } });
        deleted += res.deletedCount || 0;
        if (batch.length < BATCH_SIZE) break;
      }
      totalDeleted += deleted;
      perCollection.push({ name, deleted });
    } catch (err) {
      // Missing collection (never created) is fine — record and continue.
      perCollection.push({ name, deleted: 0, error: String(err && err.message || err).slice(0, 300) });
    }
  }

  const failed = perCollection.filter((c) => c.error);
  const doc = {
    trigger: "atlas-trigger",
    startedAt,
    finishedAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - startedMs) / 100) / 10,
    status: failed.length === 0 ? "SUCCESS" : "PARTIAL",
    totalDeleted,
    collectionsCleaned: perCollection.filter((c) => !c.error).length,
    collections: perCollection,
    error: failed.length ? failed.map((c) => `${c.name}: ${c.error}`).join("; ").slice(0, 500) : null,
    ts: new Date(),
  };
  await db.collection("atlas_cleanup_log").insertOne(doc);
  console.log(`Atlas cleanup ${doc.status}: ${totalDeleted} records in ${doc.collectionsCleaned} collections`);
  return doc;
};
