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


// A submission carrying fewer identifiers than are stored used to be merged entry by entry, which
// overwrote the first few in place and left the rest: the iSantePlus id and the code national were
// lost and the biometric code appeared twice. The duplicate then defeated rule 1, because buildQuery
// joins a field's values and "HT-1 HT-1" matches nothing.
describe('Applying a submitted patient over the stored one', () => {
  const { applySubmittedResource } = require('../lib/mixins/matchMixin');

  const stored = () => ({
    resourceType: 'Patient',
    id: 'b8ed988f-0000-4000-8000-000000000001',
    gender: 'male',
    identifier: [
      { system: 'http://isanteplus.org/openmrs/fhir2/3-isanteplus-id', value: '1002KL' },
      { system: 'http://isanteplus.org/openmrs/fhir2/5-code-national', value: 'DS1100N' },
      { system: 'http://isanteplus.org/openmrs/fhir2/6-biometrics-national-reference-code', value: 'HT-90000458' },
      { system: 'http://sedish-haiti.org/fhir/source-key', value: '75101-86' }
    ],
    contact: [{ name: { text: 'Ana' } }]
  });
  const submitted = {
    resourceType: 'Patient',
    identifier: [
      { system: 'http://sedish-haiti.org/fhir/source-key', value: '75101-86' },
      { system: 'http://isanteplus.org/openmrs/fhir2/6-biometrics-national-reference-code', value: 'HT-90000458' }
    ]
  };
  const systems = (resource) => resource.identifier.map((identifier) => identifier.system);

  test('takes the submitted identifiers whole rather than pairing them by position', () => {
    expect(applySubmittedResource(stored(), submitted).identifier).toEqual(submitted.identifier);
  });

  test('leaves no identifier repeated', () => {
    const result = applySubmittedResource(stored(), submitted);
    expect(systems(result)).toEqual([...new Set(systems(result))]);
  });

  test('keeps arrays the submission does not carry', () => {
    expect(applySubmittedResource(stored(), submitted).contact).toEqual([{ name: { text: 'Ana' } }]);
  });

  test('keeps scalars the submission does not carry', () => {
    expect(applySubmittedResource(stored(), submitted).gender).toBe('male');
  });
});
