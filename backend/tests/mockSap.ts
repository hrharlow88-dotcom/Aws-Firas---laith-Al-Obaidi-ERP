import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * In-process stand-in for the SAP Business One Service Layer, covering the
 * calls the ERP makes: Login, JournalEntries (GET by Reference, POST),
 * ChartOfAccounts and ProfitCenters.
 */
export interface MockSap {
  url: string;
  documents: Array<Record<string, unknown> & { JdtNum: number }>;
  logins: number;
  /** Next POST saves the document but answers 500, as if the response was lost. */
  loseNextResponse: boolean;
  close: () => Promise<void>;
}

export async function startMockSap(): Promise<MockSap> {
  const app = express();
  app.use(express.json());
  const state: MockSap = { url: '', documents: [], logins: 0, loseNextResponse: false, close: async () => undefined };
  const accounts = ['610100', '610200', '610300', '610400', '210500', '140300', '220100', '710900'];
  let nextJdt = 1000;

  const authorized = (req: express.Request) => /B1SESSION=mock-session/.test(req.header('cookie') || '');
  const fail = (res: express.Response, status: number, message: string) =>
    res.status(status).json({ error: { code: -5002, message: { lang: 'en-us', value: message } } });

  app.post('/b1s/v1/Login', (req, res) => {
    const { CompanyDB, UserName, Password } = req.body ?? {};
    if (CompanyDB !== 'SBO_LAITH' || UserName !== 'manager' || Password !== 'sap-pass') {
      fail(res, 401, 'Invalid login credential.');
      return;
    }
    state.logins += 1;
    res.setHeader('Set-Cookie', ['B1SESSION=mock-session; HttpOnly; Path=/b1s/v1', 'ROUTEID=.node1; Path=/b1s']);
    res.json({ SessionId: 'mock-session', Version: '1000180', SessionTimeout: 30 });
  });

  app.get('/b1s/v1/JournalEntries', (req, res) => {
    if (!authorized(req)) {
      fail(res, 401, 'Invalid session.');
      return;
    }
    const filter = String(req.query.$filter || '');
    const match = filter.match(/^Reference eq '(.*)'$/);
    const reference = match ? match[1].replace(/''/g, "'") : null;
    res.json({ value: state.documents.filter((doc) => doc.Reference === reference).map((doc) => ({ JdtNum: doc.JdtNum })) });
  });

  app.post('/b1s/v1/JournalEntries', (req, res) => {
    if (!authorized(req)) {
      fail(res, 401, 'Invalid session.');
      return;
    }
    const lines = (req.body?.JournalEntryLines ?? []) as Array<Record<string, number | string | undefined>>;
    const unknown = lines.find((line) => !accounts.includes(String(line.AccountCode)));
    if (unknown) {
      fail(res, 400, `Invalid account code '${unknown.AccountCode}'`);
      return;
    }
    const sum = (key: string) => Math.round(lines.reduce((total, line) => total + Number(line[key] ?? 0), 0) * 100);
    const foreign = lines.some((line) => line.FCCurrency);
    if (foreign ? sum('FCDebit') !== sum('FCCredit') : sum('Debit') !== sum('Credit')) {
      fail(res, 400, 'Unbalanced transaction');
      return;
    }
    if (String(req.body.Memo).length > 50 || lines.some((line) => String(line.LineMemo ?? '').length > 50)) {
      fail(res, 400, 'Value too long in property Memo');
      return;
    }
    const document = { ...req.body, JdtNum: nextJdt += 1 };
    state.documents.push(document);
    if (state.loseNextResponse) {
      state.loseNextResponse = false;
      res.status(502).send('Bad gateway');
      return;
    }
    res.status(201).json({ JdtNum: document.JdtNum });
  });

  app.get('/b1s/v1/ChartOfAccounts', (req, res) => {
    if (!authorized(req)) {
      fail(res, 401, 'Invalid session.');
      return;
    }
    res.json({ value: accounts.map((code) => ({ Code: code, Name: `Account ${code}` })) });
  });

  app.get('/b1s/v1/ProfitCenters', (_req, res) => {
    res.json({ value: [{ CenterCode: 'CC-SALES', CenterName: 'Sales', InWhichDimension: 1 }] });
  });

  const server: Server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/b1s/v1`;
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}
