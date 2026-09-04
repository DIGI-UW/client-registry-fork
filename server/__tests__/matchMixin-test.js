jest.mock('request');
jest.mock('axios');
const URI = require('urijs');
const config = require('../lib/config');
const FHIR_BASE_URL = URI(config.get('fhirServer:baseURL')).toString();
const REPROCESS_SEARCH_URL = `${FHIR_BASE_URL}/Patient?_tag=require-reprocess`;

const UNTAGGED_PATIENT_BUNDLE = {
  resourceType: 'Bundle',
  type: 'searchset',
  total: 1,
  entry: [{
    resource: {
      resourceType: 'Patient',
      id: '9c1f60a5-0000-4000-8000-00000000000b',
      meta: {
        tag: [{
          system: 'http://openclientregistry.org/fhir/require-reprocess',
          code: 'require-reprocess'
        }]
      }
    }
  }]
};

const FAILED_SEARCH_OUTCOME = {
  resourceType: 'OperationOutcome',
  issue: [{
    severity: 'error',
    code: 'processing',
    diagnostics: 'Failed to call access method'
  }]
};

// A fresh module registry per case, because reprocessing_running lives for the life of the module
// and a run that leaves it set is invisible to any later assertion inside the same instance.
const loadReprocessing = (searchResult) => {
  let request, matchMixin;
  jest.isolateModules(() => {
    request = require('request');
    matchMixin = require('../lib/mixins/matchMixin');
  });
  request.__setFhirResults(REPROCESS_SEARCH_URL, null, JSON.stringify(searchResult));
  let searches = 0;
  const get = request.get;
  request.get = (options, callback) => {
    if (decodeURIComponent(options.url) === REPROCESS_SEARCH_URL) {
      searches++;
    }
    return get(options, callback);
  };
  return {
    reprocessPatients: matchMixin.reprocessPatients,
    searchCount: () => searches
  };
};

describe('Reprocessing patients', () => {
  test('searches again on the run after one that found nothing to reprocess', async () => {
    const { reprocessPatients, searchCount } = loadReprocessing(require('./FHIRResources/emptybundle.json'));
    await reprocessPatients();
    await reprocessPatients();
    expect(searchCount()).toBe(2);
  });

  test('searches again on the run after one that skipped a patient carrying no client id', async () => {
    const { reprocessPatients, searchCount } = loadReprocessing(UNTAGGED_PATIENT_BUNDLE);
    await reprocessPatients();
    await reprocessPatients();
    expect(searchCount()).toBe(2);
  });

  test('searches again on the run after a search that answered with an OperationOutcome', async () => {
    const { reprocessPatients, searchCount } = loadReprocessing(FAILED_SEARCH_OUTCOME);
    await reprocessPatients();
    await reprocessPatients();
    expect(searchCount()).toBe(2);
  });
});
