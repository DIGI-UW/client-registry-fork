'use strict';
/*global process */

const CUSTOM_CR_BASE_URI = 'http://cr.example.org/fhir';
process.env.systems__CRBaseURI = CUSTOM_CR_BASE_URI;

jest.mock('request');
jest.mock('axios');
jest.mock('../lib/esMatching', () => ({ performMatch: jest.fn() }));
jest.mock('../lib/tools/cacheFHIR', () => ({ fhir2ES: (options, callback) => callback() }));

const _ = require('lodash');
const URI = require('urijs');
const config = require('../lib/config');
// nconf snapshots the environment when lib/config is required, so the override is dropped again
// here to keep it out of any other suite sharing this jest worker process.
delete process.env.systems__CRBaseURI;
const request = require('request');
const esMatching = require('../lib/esMatching');
const matchMixin = require('../lib/mixins/matchMixin');

const FHIR_BASE_URL = URI(config.get('fhirServer:baseURL')).toString();
const SOURCE_ID = '433ebeb6-1d89-4b64-97e6-a985675ca571';
const CURRENT_GOLDEN_ID = 'eda0fdeb-1d52-4878-a84f-ccf581ef9fff';
const OTHER_GOLDEN_ID = '11111111-2222-3333-4444-555555555555';

const PATIENT3 = require('./FHIRResources/patient3.json');
const PATIENT3_AND_LINK = require('./FHIRResources/patient3andlink.json');

const savedBundles = [];

beforeAll(() => {
  request.post = (options, callback) => {
    savedBundles.push(_.cloneDeep(options.json));
    const entry = (options.json.entry || []).map(() => ({
      response: { status: '200 OK', etag: '1', location: 'Patient/x/_history/1' }
    }));
    callback(null, { statusCode: 200 }, { resourceType: 'Bundle', type: 'batch-response', entry });
  };
});

// The patient-and-golden-record search result addPatient looks up by identifier, with extraTags
// added to the source patient so a test can put it under adjudication.
const searchResult = (extraTags) => {
  const result = _.cloneDeep(PATIENT3_AND_LINK);
  result.entry[0].resource.meta.tag.push(...extraTags);
  return result;
};

const submit = (searchBundle, matchResults) => {
  savedBundles.length = 0;
  request.__setFhirResults(
    `${FHIR_BASE_URL}/Patient?identifier=http://clientregistry.org/openmrs|patient3&_include=Patient:link`,
    null,
    JSON.stringify(searchBundle)
  );
  esMatching.performMatch.mockImplementation((params, callback) => callback(matchResults));
  return new Promise((resolve) => {
    matchMixin.addPatient('openmrs', { entry: [{ resource: _.cloneDeep(PATIENT3) }] }, () => resolve());
  });
};

const savedResources = (id) => savedBundles.reduce((found, bundle) => {
  return found.concat((bundle.entry || []).filter((entry) => entry.resource && entry.resource.id === id));
}, []).map((entry) => entry.resource);

describe('Testing tag systems shared with lib/routes/match.js', () => {
  test('matchIssues tags are written under the configured CRBaseURI', async () => {
    const potentialMatch = {
      resource: { resourceType: 'Patient', id: 'a-potential-match', link: [{ other: { reference: `Patient/${OTHER_GOLDEN_ID}` } }] }
    };
    await submit(searchResult([]), {
      FHIRAutoMatched: { entry: [] },
      FHIRPotentialMatches: { entry: [potentialMatch] },
      FHIRConflictsMatches: { entry: [] },
      ESMatches: [],
      matchedGoldenRecords: { entry: [_.cloneDeep(PATIENT3_AND_LINK.entry[1])] }
    });

    const tags = _.flatten(savedResources(SOURCE_ID).map((resource) => resource.meta.tag));
    expect(tags).toEqual(expect.arrayContaining([expect.objectContaining({
      system: `${CUSTOM_CR_BASE_URI}/matchIssues`,
      code: 'potentialMatches'
    })]));
  });

  test('a humanAdjudication tag under the configured CRBaseURI keeps the adjudicated link', async () => {
    const otherGolden = {
      resource: { resourceType: 'Patient', id: OTHER_GOLDEN_ID, link: [] }
    };
    await submit(searchResult([{ system: `${CUSTOM_CR_BASE_URI}/humanAdjudication`, code: 'humanAdjudication' }]), {
      FHIRAutoMatched: { entry: [] },
      FHIRPotentialMatches: { entry: [] },
      FHIRConflictsMatches: { entry: [] },
      ESMatches: [],
      matchedGoldenRecords: { entry: [otherGolden] }
    });

    const links = _.flatten(savedResources(SOURCE_ID).map((resource) => resource.link || []));
    const references = links.map((link) => link.other.reference);
    expect(references).toContain(`Patient/${CURRENT_GOLDEN_ID}`);
    expect(references).not.toContain(`Patient/${OTHER_GOLDEN_ID}`);
  });
});
