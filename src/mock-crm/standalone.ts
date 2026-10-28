// Run the mock CRM on its own: npm run crm
import { startMockCrm } from "./server.js";

const port = Number(process.env.CRM_PORT ?? 4010);
startMockCrm({ port }).then((crm) => console.log(`Mock CRM listening on ${crm.url}`));
