import { runStoreContractTests } from './store-contract.test-helper.ts';
import { MemoryStore } from './memory-store.ts';

runStoreContractTests('MemoryStore', () => new MemoryStore());