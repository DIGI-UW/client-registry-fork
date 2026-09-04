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

// The identifier system is none of the ones registered as an internal id, so addPatient reports the
// patient as an error without reaching the FHIR server for it.
const UNPROCESSABLE_PATIENT_BUNDLE = {
  resourceType: 'Bundle',
  type: 'searchset',
  total: 1,
  entry: [{
    resource: {
      resourceType: 'Patient',
      id: '9c1f60a5-0000-4000-8000-00000000000c',
      identifier: [{
        system: 'http://health.go.ug/cr/nationalid',
        value: '1234567'
      }],
      meta: {
        tag: [{
          system: 'http://openclientregistry.org/fhir/require-reprocess',
          code: 'require-reprocess'
        }, {
          system: 'http://openclientregistry.org/fhir/clientid',
          code: 'openmrs'
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
// Deferring the search response is what lets two runs overlap: the transport mock otherwise answers
// inside the call, so consecutive calls never meet.
const loadReprocessing = (searchResult, {defer = false} = {}) => {
  let request, matchMixin, logger;
  jest.isolateModules(() => {
    request = require('request');
    matchMixin = require('../lib/mixins/matchMixin');
    logger = require('../lib/winston');
  });
  request.__setFhirResults(REPROCESS_SEARCH_URL, null, JSON.stringify(searchResult));
  const errors = [];
  jest.spyOn(logger, 'error').mockImplementation((message) => {
    errors.push(String(message));
  });
  let searches = 0;
  const get = request.get;
  request.get = (options, callback) => {
    if (decodeURIComponent(options.url) === REPROCESS_SEARCH_URL) {
      searches++;
      if (defer) {
        return setImmediate(() => get(options, callback));
      }
    }
    return get(options, callback);
  };
  return {
    reprocessPatients: matchMixin.reprocessPatients,
    searchCount: () => searches,
    errors
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

  test('searches again on the run after one that reprocessed a patient addPatient rejected', async () => {
    const { reprocessPatients, searchCount, errors } = loadReprocessing(UNPROCESSABLE_PATIENT_BUNDLE);
    await reprocessPatients();
    expect(errors).toContain('An error has occured while adding patient');
    await reprocessPatients();
    expect(searchCount()).toBe(2);
  });

  test('searches again on the run after a search that answered with an OperationOutcome', async () => {
    const { reprocessPatients, searchCount, errors } = loadReprocessing(FAILED_SEARCH_OUTCOME);
    await reprocessPatients();
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('Search for patients requiring reprocessing failed')
    ]));
    await reprocessPatients();
    expect(searchCount()).toBe(2);
  });

  test('leaves a run in flight to finish rather than starting a second pass', async () => {
    const { reprocessPatients, searchCount } = loadReprocessing(require('./FHIRResources/emptybundle.json'), {defer: true});
    // Three calls: the second one only demonstrates the guard holding the flag once a third arrives
    // and finds it still set.
    await Promise.all([reprocessPatients(), reprocessPatients(), reprocessPatients()]);
    expect(searchCount()).toBe(1);
  });
});
