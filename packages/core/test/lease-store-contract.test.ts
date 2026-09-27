import { createInMemoryLeaseStore, createLeaseStoreContractTests } from "../src/testing.js";

createLeaseStoreContractTests(() => createInMemoryLeaseStore());
