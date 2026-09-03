jest.mock('request');
jest.mock('axios');
const URI = require('urijs');
const config = require('../lib/config');
const FHIR_BASE_URL = URI(config.get('fhirServer:baseURL')).toString();
const ES_BASE_URL = URI(config.get('elastic:server')).segment(config.get('elastic:index')).toString();

const supertest = require("supertest");

const route = require("../lib/routes/match");
const { buildQuery, performMatch } = require("../lib/esMatching");

const express = require('express');
const app = express();
app.use(express.json());

const request = require("request");
const axios = require("axios");

app.use("/", route);

const SHIPPED_RULES = config.get('rules');
const PATIENT1 = 'bc58707b-62f1-498a-8fb3-568cd5b69db2';
const PATIENT2 = 'd55e15fd-d7a6-42b8-89cc-560e3578ef7f';
const PATIENT3 = '433ebeb6-1d89-4b64-97e6-a985675ca571';
const PATIENT1_GOLDEN = '739d4023-40eb-4f44-8d14-3355926bd60d';
const STALE_ID = '9c1f60a5-0000-4000-8000-000000000001';

// A one field rule that auto matches at 1.0 and a wider rule whose potential matches start at 3.0.
// Both are needed to tell the two winner selection conditions apart: with a single rule every
// candidate is scored against the same autoMatchThreshold and they agree.
const NARROW_AND_WIDE_RULES = [{
  matchingType: "deterministic",
  fields: {
    phone: {
      algorithm: "exact",
      fhirpath: "telecom.where(system='phone').value",
      espath: "phone"
    }
  },
  potentialMatchThreshold: 1,
  autoMatchThreshold: 1
}, {
  matchingType: "deterministic",
  fields: {
    given: {
      algorithm: "jaro-winkler-similarity",
      threshold: 0.8,
      fhirpath: "name.where(use='official').given",
      espath: "given"
    },
    family: {
      algorithm: "damerau-levenshtein",
      threshold: 3,
      fhirpath: "name.where(use='official').family",
      espath: "family"
    },
    birthDate: {
      algorithm: "exact",
      fhirpath: "birthDate",
      espath: "birthDate"
    }
  },
  potentialMatchThreshold: 3,
  autoMatchThreshold: 4,
  filters: {
    gender: {
      fhirpath: "gender",
      espath: "gender"
    }
  }
}];

function esResults(hits) {
  return {
    took: 0,
    timed_out: false,
    hits: {
      total: {
        value: hits.length,
        relation: "eq"
      },
      max_score: hits.length ? hits[0]._score : null,
      hits
    }
  };
}

function esHit(id, score) {
  return {
    _index: "patients",
    _type: "_doc",
    _id: id,
    _score: score,
    _source: {
      gender: "male",
      birthDate: "1972-01-08",
      given: "Emanuel",
      family: "Joshua",
      phone: "0678 56160",
      patients: `Patient/${id}`
    }
  };
}

function ids(bundle) {
  return bundle.entry.map((entry) => {
    return entry.resource.id;
  });
}

describe( "Testing elasticsearch matching", () => {
  afterEach(() => {
    config.set('rules', SHIPPED_RULES);
  });

  test( "Testing A Potential Only Hit Does Not Outrank An Auto Match", () => {
    const patient3 = require("./FHIRResources/patient3.json");
    const patient1AndLink = require("./FHIRResources/patient1andlinkAfterBrokenMatchWithoutRematch.json");
    const patient2AndLink = require("./FHIRResources/patient2andlinkAfterBrokenMatchWithoutRematch.json");
    config.set('rules', NARROW_AND_WIDE_RULES);

    // patient1 and patient2 both auto match on the narrow rule, patient2 also comes back from the
    // wide rule at a higher score that is still below that rule's autoMatchThreshold
    axios.__setFhirResults(
      `${ES_BASE_URL}/_search?scroll=1m&size=1000`,
      buildQuery(patient3, NARROW_AND_WIDE_RULES[0]),
      esResults([esHit(PATIENT1, 1.0), esHit(PATIENT2, 1.0)])
    );
    axios.__setFhirResults(
      `${ES_BASE_URL}/_search?scroll=1m&size=1000`,
      buildQuery(patient3, NARROW_AND_WIDE_RULES[1]),
      esResults([esHit(PATIENT2, 3.0)])
    );

    request.__setFhirResults(
      `${FHIR_BASE_URL}/Patient?_id=${PATIENT1},${PATIENT2}&_include=Patient:link`,
      null,
      JSON.stringify({ entry: patient1AndLink.entry.concat(patient2AndLink.entry) })
    );
    request.__setFhirResults(
      `${FHIR_BASE_URL}/Patient?_id=${PATIENT2}`,
      null,
      JSON.stringify({ entry: [patient2AndLink.entry[0]] })
    );

    return new Promise((resolve) => {
      performMatch({ sourceResource: patient3, ignoreList: [PATIENT3] }, resolve);
    }).then(({ FHIRAutoMatched, FHIRConflictsMatches, matchedGoldenRecords }) => {
      expect(ids(FHIRAutoMatched)).toEqual([PATIENT1]);
      expect(ids(FHIRConflictsMatches)).toEqual([PATIENT2]);
      expect(ids(matchedGoldenRecords)).toEqual([PATIENT1_GOLDEN]);
    });
  });

  test( "Testing A Stale Winner Falls Back To The Highest Scoring Live Auto Match", () => {
    const patient3 = require("./FHIRResources/patient3.json");
    const patient1AndLink = require("./FHIRResources/patient1andlinkAfterBrokenMatchWithoutRematch.json");
    const patient2AndLink = require("./FHIRResources/patient2andlinkAfterBrokenMatchWithoutRematch.json");
    const NARROW_RULE = [NARROW_AND_WIDE_RULES[0]];
    config.set('rules', NARROW_RULE);

    // all three hits clear the rule's autoMatchThreshold and the stale one outscores both live
    // patients, so resourceID starts on a document the FHIR server no longer has a patient for.
    // patient1 and patient2 hang off different golden records, so which one the fallback picks
    // decides which golden record the submitted patient is matched into
    axios.__setFhirResults(
      `${ES_BASE_URL}/_search?scroll=1m&size=1000`,
      buildQuery(patient3, NARROW_RULE[0]),
      esResults([esHit(STALE_ID, 3.0), esHit(PATIENT1, 2.0), esHit(PATIENT2, 1.0)])
    );

    request.__setFhirResults(
      `${FHIR_BASE_URL}/Patient?_id=${STALE_ID},${PATIENT1},${PATIENT2}&_include=Patient:link`,
      null,
      JSON.stringify({ entry: patient1AndLink.entry.concat(patient2AndLink.entry) })
    );

    return new Promise((resolve) => {
      performMatch({ sourceResource: patient3, ignoreList: [PATIENT3] }, resolve);
    }).then(({ FHIRAutoMatched, FHIRConflictsMatches, matchedGoldenRecords }) => {
      expect(ids(FHIRAutoMatched)).toEqual([PATIENT1]);
      expect(ids(FHIRConflictsMatches)).toEqual([PATIENT2]);
      expect(ids(matchedGoldenRecords)).toEqual([PATIENT1_GOLDEN]);
    });
  });

  // the FHIR server no longer holds the patient the elasticsearch document points at
  function mockStaleIndex(patient3) {
    request.__setFhirResults(
      `${FHIR_BASE_URL}/Patient/${PATIENT3}`,
      null,
      JSON.stringify(patient3)
    );
    request.__setFhirResults(
      `${FHIR_BASE_URL}/Patient?_id=${STALE_ID}&_include=Patient:link`,
      null,
      JSON.stringify({ resourceType: "Bundle", type: "searchset", total: 0, entry: [] })
    );
    axios.__setFhirResults(
      `${ES_BASE_URL}/_search?scroll=1m&size=1000`,
      buildQuery(patient3, SHIPPED_RULES[0]),
      esResults([esHit(STALE_ID, 3.0)])
    );
  }

  test( "Testing A Stale Elasticsearch Document Is Reclassified As A Conflict", () => {
    const patient3 = require("./FHIRResources/patient3.json");
    mockStaleIndex(patient3);

    return new Promise((resolve) => {
      performMatch({ sourceResource: patient3, ignoreList: [PATIENT3] }, resolve);
    }).then(({ FHIRAutoMatched, ESMatches, matchedGoldenRecords }) => {
      expect(ids(FHIRAutoMatched)).toEqual([]);
      expect(ids(matchedGoldenRecords)).toEqual([]);
      expect(ESMatches[0].autoMatchResults).toEqual([]);
      expect(ESMatches[0].conflictsMatchResults.map((hit) => hit['_id'])).toEqual([STALE_ID]);
    });
  });

  test( "Testing Getting Potential Matches Against A Stale Index", () => {
    const patient3 = require("./FHIRResources/patient3.json");
    mockStaleIndex(patient3);

    return supertest(app)
      .get(`/potential-matches/${PATIENT3}`)
      .send()
      .then((response) => {
        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveLength(1);
        expect(response.body[0].id).toBe(PATIENT3);
        expect(response.body[0].scores).toEqual({});
      });
  });
} );
