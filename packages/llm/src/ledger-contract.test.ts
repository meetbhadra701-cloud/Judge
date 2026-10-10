import { defineLedgerContract } from './testing/ledger-contract.js';
import { budgetFor } from './testing/builders.js';

defineLedgerContract('in-memory', budgetFor);
