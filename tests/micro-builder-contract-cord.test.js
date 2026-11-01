import { contractTests } from './helpers/builder-contract.js';

/**
 * The builder contract (tests/helpers/builder-contract.js) for the scatter types on a live cord
 * (#750, #759): their cords cost more to prove, so they have a file of their own (31: 15 s).
 */
contractTests(['rubble', 'park', 'plant']);
