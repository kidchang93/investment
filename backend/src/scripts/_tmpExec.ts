import { getKisAccount } from '../config.js';
import { getKisDomesticExecutions } from '../kis/rest.js';
const account = getKisAccount('VTS-ORDINARY');
const snap = await getKisDomesticExecutions(account, 1);
for (const e of snap.executions) console.log(JSON.stringify(e));
