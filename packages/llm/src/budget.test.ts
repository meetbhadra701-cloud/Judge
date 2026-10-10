import { defineBudgetContract } from './testing/budget-contract.js';
import { budgetFor } from './testing/builders.js';

defineBudgetContract('in-memory ledger', budgetFor);
