import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import {
  initScheduler,
  getConfig,
  updateConfig,
  getLogs,
  getLatestReport,
  generateNewReport,
  executeDailyDispatch,
  checkSchedule,
  hasDispatchedToday,
  getCachedPdf,
  executeFlashMoveAnalysis,
  getCachedFlashPdf,
  getFlashHistory,
  recordCronPing,
} from './server/scheduler.js';
import { testDiscordWebhook } from './server/discordService.js';
import { generateMarketBriefPdf, generateFlashMovePdf } from './server/pdfGenerator.js';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Initialize scheduler and persistent storage
  initScheduler();

  // Health & Heartbeat Endpoint (Also safely checks daily schedule as a fallback if pinged by uptime monitors)
  app.all('/api/health*', async (req, res) => {
    try {
      recordCronPing(String(req.headers['user-agent'] || req.ip || 'health-check'));
      await checkSchedule();
      res.json({ status: 'ok', time: new Date().toISOString(), dispatchedToday: hasDispatchedToday() });
    } catch (err: any) {
      res.json({ status: 'ok', time: new Date().toISOString(), note: err.message });
    }
  });

  // Automated Cron Check Endpoint (can be pinged by Cloud Scheduler, cron-job.org, or uptime monitors)
  app.all('/api/cron*', async (req, res) => {
    try {
      recordCronPing(String(req.headers['user-agent'] || req.ip || 'external'));
      const scheduleResult = await checkSchedule();
      const config = getConfig();
      res.json({
        ok: true,
        dispatchedToday: hasDispatchedToday(),
        scheduleCheck: scheduleResult,
        nextRun: config.nextRunTimestamp,
        serverTimeUtc: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message || err });
    }
  });

  // Explicit Cron Force Dispatch Endpoint
  app.all('/api/cron/dispatch', async (req, res) => {
    try {
      recordCronPing(String(req.headers['user-agent'] || req.ip || 'dispatch-endpoint'));
      const force = req.query.force === 'true' || req.body?.force === true;
      if (!force && hasDispatchedToday()) {
        return res.json({
          ok: true,
          skipped: true,
          message: 'Report already dispatched today. Pass ?force=true to override.',
        });
      }
      const result = await executeDailyDispatch(true);
      res.json({ ok: true, result });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message || err });
    }
  });

  // Get Bot Configuration
  app.get('/api/config', (req, res) => {
    try {
      res.json(getConfig());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update Bot Configuration
  app.post('/api/config', (req, res) => {
    try {
      const updated = updateConfig(req.body);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Test Discord Webhook
  app.post('/api/discord/test', async (req, res) => {
    try {
      const { webhookUrl } = req.body;
      const result = await testDiscordWebhook(webhookUrl);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get Latest Market Brief
  app.get('/api/market/latest', async (req, res) => {
    try {
      let report = getLatestReport();
      if (!report) {
        const { brief } = await generateNewReport();
        report = brief;
      }
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Generate Fresh Market Brief
  app.post('/api/market/generate', async (req, res) => {
    try {
      const { brief } = await generateNewReport();
      res.json(brief);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Trigger Daily Dispatch to Discord
  app.post('/api/market/dispatch', async (req, res) => {
    try {
      const result = await executeDailyDispatch(true);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download Report as PDF
  app.get('/api/reports/:id/pdf', async (req, res) => {
    try {
      const reportId = req.params.id;
      let pdfBytes = getCachedPdf(reportId);

      if (!pdfBytes) {
        let latest = getLatestReport();
        if (!latest || latest.id !== reportId) {
          const { brief, pdfBytes: newBytes } = await generateNewReport();
          latest = brief;
          pdfBytes = newBytes;
        } else {
          pdfBytes = await generateMarketBriefPdf(latest);
        }
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="Velo_Daily_Brief_${reportId}.pdf"`);
      res.send(Buffer.from(pdfBytes));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get Delivery Logs
  app.get('/api/logs', async (req, res) => {
    try {
      res.json(await getLogs());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Analyze Big Move / Flash Anomaly On-Demand
  app.post('/api/flash/analyze', async (req, res) => {
    try {
      const result = await executeFlashMoveAnalysis(req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get Flash Move History
  app.get('/api/flash/history', (req, res) => {
    try {
      res.json(getFlashHistory());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download Flash Move PDF
  app.get('/api/flash/:id/pdf', async (req, res) => {
    try {
      const flashId = req.params.id;
      let pdfBytes = getCachedFlashPdf(flashId);

      if (!pdfBytes) {
        // Find from history if available
        const history = getFlashHistory();
        const item = history.find((f) => f.id === flashId);
        if (item) {
          pdfBytes = await generateFlashMovePdf(item);
        }
      }

      if (!pdfBytes) {
        // Generate a fresh one for BTC if not found
        const { analysis, pdfBytes: newBytes } = await executeFlashMoveAnalysis({
          assetSymbol: 'BTC',
          timeframe: '1h',
          moveType: 'AUTO_DETECT',
          generatePdf: true,
          dispatchToDiscord: false,
        });
        pdfBytes = newBytes || (await generateFlashMovePdf(analysis));
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="Velo_Flash_Breakdown_${flashId}.pdf"`);
      res.send(Buffer.from(pdfBytes));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Vite Middleware Setup
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Velo Market Pulse Bot server running on http://localhost:${PORT}`);
  });
}

startServer();
