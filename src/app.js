import express from 'express';
import config from './config/env.js';
import webhookRoutes from './routes/webhookRoutes.js';
import { instalarCapturaGlobal } from './services/reportarFallas.js';

// v3.4: los errores que nadie atrapó también llegan al CRM (Analítica → Fallas).
instalarCapturaGlobal();

const app = express();
app.use(express.json({
  limit: '5mb',
  verify: (req, res, buf, encoding) => {
    req.rawBody = buf?.toString(encoding || "utf8");
  },
}));

app.use(express.urlencoded({ limit: '5mb', extended: true }));

app.use('/', webhookRoutes);

app.get('/', (req, res) => {
  res.send(`<pre>Nothing to see here.
Checkout README.md to start.</pre>`);
});

app.listen(config.PORT, () => {
  console.log(`Server is listening on port:  ${config.PORT}`);
});