import { REGION_TYPES } from '../../map/micro/region-types.ts';
import { SLOW_SEEDS, contractTests } from '../helpers/builder-contract.js';

/**
 * The builder contract (tests/helpers/builder-contract.js) for every type at the seeds the fast
 * files leave out: `micro-builder-contract` and `micro-builder-contract-cord` run the first (#807).
 */
contractTests(Object.keys(REGION_TYPES), SLOW_SEEDS);
