jest.mock('request');
jest.mock('axios');
const fs = require('fs');
const URI = require('urijs');
const config = require('../lib/config');
const FHIR_BASE_URL = URI(config.get('fhirServer:baseURL')).toString();
const ES_BASE_URL = URI(config.get('elastic:server')).segment(config.get('elastic:index')).toString();

const supertest = require("supertest");

const route = require("../lib/routes/match");
const { buildQuery } = require("../lib/esMatching");

const express = require('express');
const app = express();
app.use(express.json());

const request = require("request");
const axios = require("axios");

app.use("/", route);

const MOCK_CREATE_RESPONSE = {
  "resourceType": "Bundle",
  "id": "f66261d4-cfdf-4e84-82f4-69d0c1b15202",
  "type": "batch-response",
  "link": [
    {
      "relation": "self",
      "url": "http://localhost:8081/clientregistry/fhir"
    }
  ],
  "entry": [
    {
      "response": {
        "status": "201 Created",
        "etag": "1",
        "lastModified": "2020-09-18T08:22:40.031+03:00"
      }
    }
  ]
};

const savedPatients = [];
beforeAll(() => {
  const post = request.post;
  request.post = (options, callback) => {
    if(options.json && Array.isArray(options.json.entry)) {
      for(const entry of options.json.entry) {
        if(entry.resource && entry.resource.resourceType === "Patient") {
          savedPatients.push(JSON.parse(JSON.stringify(entry.resource)));
        }
      }
    }
    return post(options, callback);
  };
});

const esHit = (id, score) => {
  return {
    _index: "patients",
    _type: "_doc",
    _id: id,
    _score: score,
    _source: { patients: `Patient/${id}` }
  };
};
const esSearchResults = (hits) => {
  return {
    took: 0,
    timed_out: false,
    hits: {
      total: { value: hits.length, relation: "eq" },
      max_score: Math.max(...hits.map((hit) => hit._score)),
      hits
    }
  };
};
const tagsLastSavedOn = (id) => {
  const saved = savedPatients.filter((resource) => resource.id === id).pop();
  return saved.meta.tag.map((tag) => `${tag.system}|${tag.code}`);
};

beforeEach(() => {
  savedPatients.length = 0;
});

describe( "Testing express", () => {
  test( "Testing Breaking Matches", () => {
    const ids = [ 'Patient/d55e15fd-d7a6-42b8-89cc-560e3578ef7f' ];
    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?_id=Patient/d55e15fd-d7a6-42b8-89cc-560e3578ef7f`, null, JSON.stringify(
      {
        "entry": [{
          "resource": require("./FHIRResources/patient2.json")
        }]
      }
    ) );
    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?_id=739d4023-40eb-4f44-8d14-3355926bd60d`, null, JSON.stringify(
      {
        "entry": [{
          "resource": require("./FHIRResources/goldenrecord-739d4023-40eb-4f44-8d14-3355926bd60d.json")
        }]
      }
    ) );
    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?_id=bc58707b-62f1-498a-8fb3-568cd5b69db2`, null, JSON.stringify(
      {
        "entry": [{
          "resource": require("./FHIRResources/patient1.json")
        }]
      }
    ) );
    request.__setFhirResults( `${FHIR_BASE_URL}`, "POSTPatient", JSON.stringify(MOCK_CREATE_RESPONSE) );
    return supertest(app)
      .post("/break-match").send(ids).then( (response) => {
        expect(response.statusCode).toBe(200);
    } );

  });

  test( "Testing UnBreaking Matches", () => {
    const ids = [
      {
        id2: 'Patient/bc58707b-62f1-498a-8fb3-568cd5b69db2',
        id1: 'Patient/433ebeb6-1d89-4b64-97e6-a985675ca571'
      },
      {
        id2: 'Patient/bc58707b-62f1-498a-8fb3-568cd5b69db2',
        id1: 'Patient/d55e15fd-d7a6-42b8-89cc-560e3578ef7f'
      }
    ];
    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?_id=Patient/433ebeb6-1d89-4b64-97e6-a985675ca571,Patient/bc58707b-62f1-498a-8fb3-568cd5b69db2,Patient/d55e15fd-d7a6-42b8-89cc-560e3578ef7f`, null, JSON.stringify(
      require("./FHIRResources/unbreakmatchresources.json")
    ) );
    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?identifier=http://clientregistry.org/openmrs|patient1&_include=Patient:link`, null, JSON.stringify(require("./FHIRResources/patient1andlinkAfterBrokenMatchWithoutRematch.json")) );
    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?identifier=http://clientregistry.org/openmrs|patient2&_include=Patient:link`, null, JSON.stringify(require("./FHIRResources/patient2andlinkAfterBrokenMatchWithoutRematch.json")) );
    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?identifier=http://clientregistry.org/openmrs|patient3&_include=Patient:link`, null, JSON.stringify(require("./FHIRResources/patient3andlinkAfterBrokenMatchWithoutRematch.json")) );
    request.__setFhirResults( `${ES_BASE_URL}/_refresh`, null, require("./ESResources/refreshindex.json"));
    request.__setFhirResults( `${ES_BASE_URL}/_search`, require("./ESResources/decisionruleforpatient1.json"), require("./ESResources/searchresultsforpatient1.json"));
    request.__setFhirResults( `${ES_BASE_URL}/_search`, require("./ESResources/decisionruleforpatient2.json"), require("./ESResources/searchresultsforpatient2.json"));
    request.__setFhirResults( `${ES_BASE_URL}/_search`, require("./ESResources/decisionruleforpatient3.json"), require("./ESResources/searchresultsforpatient3.json"));

    const brokenPatient3 = require("./FHIRResources/patient3andlinkAfterBrokenMatchWithoutRematch.json");
    const brokenPatient1 = require("./FHIRResources/patient1andlinkAfterBrokenMatchWithoutRematch.json");
    const brokenPatient2 = require("./FHIRResources/patient2andlinkAfterBrokenMatchWithoutRematch.json");

    const patient3 = brokenPatient3.entry.find((entry) => {
      return entry.resource.identifier.find((id) => {
        return id.value === 'patient3';
      });
    });
    const patient3Bundle = {
      entry: [{
        resource: patient3.resource
      }]
    };

    const patient1 = brokenPatient1.entry.find((entry) => {
      return entry.resource.identifier.find((id) => {
        return id.value === 'patient1';
      });
    });
    const patient2 = brokenPatient2.entry.find((entry) => {
      return entry.resource.identifier.find((id) => {
        return id.value === 'patient2';
      });
    });
    const patient1and2Bundle = {
      entry: [{
        resource: patient1.resource
      }, {
        resource: patient2.resource
      }]
    };
    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?_id=433ebeb6-1d89-4b64-97e6-a985675ca571`, null, JSON.stringify(patient3Bundle) );
    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?_id=bc58707b-62f1-498a-8fb3-568cd5b69db2&_include=Patient:link`, null, JSON.stringify(brokenPatient1) );
    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?_id=d55e15fd-d7a6-42b8-89cc-560e3578ef7f&_include=Patient:link`, null, JSON.stringify(brokenPatient2) );
    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?_id=bc58707b-62f1-498a-8fb3-568cd5b69db2,d55e15fd-d7a6-42b8-89cc-560e3578ef7f`, null, JSON.stringify(patient1and2Bundle) );
    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?_id=d55e15fd-d7a6-42b8-89cc-560e3578ef7f,bc58707b-62f1-498a-8fb3-568cd5b69db2`, null, JSON.stringify(patient1and2Bundle) );

    request.__setFhirResults( `${FHIR_BASE_URL}`, "POSTPatient", JSON.stringify(MOCK_CREATE_RESPONSE) );
    request.__setFhirResults( `${FHIR_BASE_URL}/Basic/patientreport`, null, JSON.stringify(require("./FHIRResources/patientreport.json")));
    request.__setFhirResults( `${FHIR_BASE_URL}/StructureDefinition/Patient`, null, JSON.stringify(require("./FHIRResources/PatientStructureDefinition.json")));
    axios.__setFhirResults( `${ES_BASE_URL}/_cluster/settings`, {
      transient: {
        'script.max_compilations_rate': config.get('elastic:max_compilations_rate'),
      },
    }, {
      acknowledged: true,
      persistent: {},
      transient: {
        script: {
          max_compilations_rate: config.get('elastic:max_compilations_rate')
        }
      }
    });
    axios.__setFhirResults( `${ES_BASE_URL}`, require("./ESResources/indexSettings.json"), {
      acknowledged: true,
      shards_acknowledged: true,
      index: "patients"
    });
    axios.__setFhirResults( `${ES_BASE_URL}/_mapping`, require("./ESResources/indexMappings.json"), { acknowledged: true });
    axios.__setFhirResults( `${ES_BASE_URL}/_doc/bc58707b-62f1-498a-8fb3-568cd5b69db2`, require("./ESResources/cacheRequest-bc58707b-62f1-498a-8fb3-568cd5b69db2.json"), require("./ESResources/cacheResults-bc58707b-62f1-498a-8fb3-568cd5b69db2.json"));
    axios.__setFhirResults( `${ES_BASE_URL}/_doc/d55e15fd-d7a6-42b8-89cc-560e3578ef7f`, require("./ESResources/cacheRequest-d55e15fd-d7a6-42b8-89cc-560e3578ef7f.json"), require("./ESResources/cacheResults-d55e15fd-d7a6-42b8-89cc-560e3578ef7f.json"));
    axios.__setFhirResults( `${ES_BASE_URL}/_doc/433ebeb6-1d89-4b64-97e6-a985675ca571`, require("./ESResources/cacheRequest-433ebeb6-1d89-4b64-97e6-a985675ca571.json"), require("./ESResources/cacheResults-433ebeb6-1d89-4b64-97e6-a985675ca571.json"));
    return supertest(app)
      .post("/unbreak-match").send(ids).then( (response) => {
        expect(response.statusCode).toBe(201);
    } );

  });

  test( "Testing Count Match Issues", () => {
    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?_tag=http://openclientregistry.org/fhir/matchIssues|potentialMatches,http://openclientregistry.org/fhir/matchIssues|conflictMatches&_summary=count`, null, JSON.stringify(require("./FHIRResources/totalMatchIssues.json")) );
    return supertest(app)
      .get("/count-match-issues").send().then( (response) => {
        expect(response.statusCode).toBe(200);
        expect(response.body.total).toEqual(1);
    } );
  });

  //testing getting potential matches
  test( "Testing Getting Potential Matches", () => {
    const potentialMatches = require("./otherResources/potentialMatches.json");
    const decisionRules = config.get("rules");

    request.__setFhirResults(
      `${FHIR_BASE_URL}/Patient/433ebeb6-1d89-4b64-97e6-a985675ca571`,
      null,
      JSON.stringify(require("./FHIRResources/patient3.json"))
    );
    request.__setFhirResults(
      `${FHIR_BASE_URL}/Patient/bc58707b-62f1-498a-8fb3-568cd5b69db2`,
      null,
      JSON.stringify(require("./FHIRResources/patient1.json"))
    );
    request.__setFhirResults(
      `${FHIR_BASE_URL}/Patient/d55e15fd-d7a6-42b8-89cc-560e3578ef7f`,
      null,
      JSON.stringify(require("./FHIRResources/patient2.json"))
    );

    // fhir search results for potential matches
    request.__setFhirResults(
      `${FHIR_BASE_URL}/Patient?_id=bc58707b-62f1-498a-8fb3-568cd5b69db2,d55e15fd-d7a6-42b8-89cc-560e3578ef7f`,
      null,
      JSON.stringify({
        entry: [
          require("./FHIRResources/patient1andlinkAfterBrokenMatchWithoutRematch.json")
            .entry[0],
          require("./FHIRResources/patient2andlinkAfterBrokenMatchWithoutRematch.json")
            .entry[0],
        ],
      })
    );
    request.__setFhirResults(
      `${FHIR_BASE_URL}/Patient?_id=bc58707b-62f1-498a-8fb3-568cd5b69db2&_include=Patient:link`,
      null,
      JSON.stringify(
        require("./FHIRResources/patient1andlinkAfterBrokenMatchWithoutRematch.json")
      )
    );
    request.__setFhirResults(
      `${FHIR_BASE_URL}/Patient?_id=d55e15fd-d7a6-42b8-89cc-560e3578ef7f&_include=Patient:link`,
      null,
      JSON.stringify(
        require("./FHIRResources/patient2andlinkAfterBrokenMatchWithoutRematch.json")
      )
    );
    request.__setFhirResults(
      `${FHIR_BASE_URL}/Patient?_id=433ebeb6-1d89-4b64-97e6-a985675ca571`,
      null,
      JSON.stringify(
        require("./FHIRResources/patient3andlinkAfterBrokenMatchWithoutRematch.json")
      )
    );
    axios.__setFhirResults(
      `${ES_BASE_URL}/_search?scroll=1m&size=1000`,
      buildQuery(require("./FHIRResources/patient3.json"), decisionRules[0]),
      require("./ESResources/searchresultsforpatient3.json")
    );
    axios.__setFhirResults(
      `${ES_BASE_URL}/_search?scroll=1m&size=1000`,
      buildQuery(require("./FHIRResources/patient2.json"), decisionRules[0]),
      require("./ESResources/searchresultsforpatient2.json")
    );
    axios.__setFhirResults(
      `${ES_BASE_URL}/_search?scroll=1m&size=1000`,
      buildQuery(require("./FHIRResources/patient1.json"), decisionRules[0]),
      require("./ESResources/searchresultsforpatient1.json")
    );

    return supertest(app)
      .get("/potential-matches/433ebeb6-1d89-4b64-97e6-a985675ca571")
      .send()
      .then((response) => {
        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual(potentialMatches);
      });
  });

  test( "Testing Getting Match Issues", () => {
    const allMatchIssues = require("./FHIRResources/allMatchIssues.json");
    const allMatchIssuesRes = require("./otherResources/allMatchIssues.json");
    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?_tag=http://openclientregistry.org/fhir/matchIssues|potentialMatches,http://openclientregistry.org/fhir/matchIssues|conflictMatches`, null, JSON.stringify(allMatchIssues) );
    return supertest(app)
      .get("/get-match-issues").send().then( (response) => {
        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual(allMatchIssuesRes);
    } );
  });

  test( "Testing Resolving Match Issues", () => {
    const resolveIssuesReqBundle = require("./otherResources/requestResolveIssue.json");
    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?_id=433ebeb6-1d89-4b64-97e6-a985675ca571,c49a52c1-88bc-41fb-9c87-bdd2a911f360,739d4023-40eb-4f44-8d14-3355926bd60d,bc58707b-62f1-498a-8fb3-568cd5b69db2,d55e15fd-d7a6-42b8-89cc-560e3578ef7f`, null, JSON.stringify(
      require("./FHIRResources/allMatchIssuesWithLinks.json")
    ) );
    return supertest(app)
      .post("/resolve-match-issue").send(resolveIssuesReqBundle).then( (response) => {
        expect(response.statusCode).toBe(200);
    } );
  });

  // The resolved-conflict filter at the top of the handler only runs when performMatch returns
  // conflicts, and the test above leaves that list empty, so nothing exercised it while link[0] was
  // read as a string. Give it real input: two hits that both clear autoMatchThreshold but hang off
  // different golden records, so the one that loses resourceID is reclassified as a conflict and the
  // filter's callback runs against a real Patient.link.
  test( "Testing Resolving Match Issues With A Conflicting Match", () => {
    const resolveIssuesReqBundle = require("./otherResources/requestResolveIssue.json");
    const allMatchIssuesWithLinks = require("./FHIRResources/allMatchIssuesWithLinks.json");
    const patient1AndLink = require("./FHIRResources/patient1andlinkAfterBrokenMatchWithoutRematch.json");
    const patient2AndLink = require("./FHIRResources/patient2andlinkAfterBrokenMatchWithoutRematch.json");
    const decisionRules = config.get("rules");
    const resolvingFrom = allMatchIssuesWithLinks.entry.find((entry) => {
      return entry.resource.id === "433ebeb6-1d89-4b64-97e6-a985675ca571";
    }).resource;
    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?_id=433ebeb6-1d89-4b64-97e6-a985675ca571,c49a52c1-88bc-41fb-9c87-bdd2a911f360,739d4023-40eb-4f44-8d14-3355926bd60d,bc58707b-62f1-498a-8fb3-568cd5b69db2,d55e15fd-d7a6-42b8-89cc-560e3578ef7f`, null, JSON.stringify(
      allMatchIssuesWithLinks
    ) );
    axios.__setFhirResults(
      `${ES_BASE_URL}/_search?scroll=1m&size=1000`,
      buildQuery(resolvingFrom, decisionRules[0]),
      esSearchResults([
        esHit("bc58707b-62f1-498a-8fb3-568cd5b69db2", decisionRules[0].autoMatchThreshold),
        esHit("d55e15fd-d7a6-42b8-89cc-560e3578ef7f", decisionRules[0].autoMatchThreshold)
      ])
    );
    // bc58707b hangs off golden 739d4023 and d55e15fd off golden 42184bd9, so whichever loses
    // resourceID lands in FHIRConflictsMatches
    request.__setFhirResults(
      `${FHIR_BASE_URL}/Patient?_id=bc58707b-62f1-498a-8fb3-568cd5b69db2,d55e15fd-d7a6-42b8-89cc-560e3578ef7f&_include=Patient:link`,
      null,
      JSON.stringify({ entry: patient1AndLink.entry.concat(patient2AndLink.entry) })
    );

    return supertest(app)
      .post("/resolve-match-issue").send(resolveIssuesReqBundle).then( (response) => {
        expect(response.statusCode).toBe(200);
        expect(tagsLastSavedOn("433ebeb6-1d89-4b64-97e6-a985675ca571")).toEqual([
          "http://openclientregistry.org/fhir/clientid|openmrs",
          "http://openclientregistry.org/fhir/automatch|autoMatches",
          "http://openclientregistry.org/fhir/humanAdjudication|humanAdjudication",
          "http://openclientregistry.org/fhir/matchIssues|conflictMatches"
        ]);
    } );
  });

  // Both flags can be outstanding at once, and the two async.parallel handlers write the same tag
  // array, so the conflict handler has to recognise its own tag rather than whatever the potential
  // handler left behind.
  test( "Testing Resolving Match Issues Flags A Conflict While A Potential Match Remains", () => {
    const resolveIssuesReqBundle = require("./otherResources/requestResolveIssue.json");
    const allMatchIssuesWithLinks = require("./FHIRResources/allMatchIssuesWithLinks.json");
    const patient1AndLink = require("./FHIRResources/patient1andlinkAfterBrokenMatchWithoutRematch.json");
    const patient2AndLink = require("./FHIRResources/patient2andlinkAfterBrokenMatchWithoutRematch.json");
    const decisionRules = config.get("rules");
    const resolvingFrom = allMatchIssuesWithLinks.entry.find((entry) => {
      return entry.resource.id === "433ebeb6-1d89-4b64-97e6-a985675ca571";
    }).resource;
    const potentialId = "a0b1c2d3-5b1e-4a17-9f0c-8e4d2f6a1b90";

    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?_id=433ebeb6-1d89-4b64-97e6-a985675ca571,c49a52c1-88bc-41fb-9c87-bdd2a911f360,739d4023-40eb-4f44-8d14-3355926bd60d,bc58707b-62f1-498a-8fb3-568cd5b69db2,d55e15fd-d7a6-42b8-89cc-560e3578ef7f`, null, JSON.stringify(
      allMatchIssuesWithLinks
    ) );
    axios.__setFhirResults(
      `${ES_BASE_URL}/_search?scroll=1m&size=1000`,
      buildQuery(resolvingFrom, decisionRules[0]),
      esSearchResults([
        esHit("bc58707b-62f1-498a-8fb3-568cd5b69db2", decisionRules[0].autoMatchThreshold),
        esHit("d55e15fd-d7a6-42b8-89cc-560e3578ef7f", decisionRules[0].autoMatchThreshold),
        esHit(potentialId, decisionRules[0].potentialMatchThreshold)
      ])
    );
    request.__setFhirResults(
      `${FHIR_BASE_URL}/Patient?_id=bc58707b-62f1-498a-8fb3-568cd5b69db2,d55e15fd-d7a6-42b8-89cc-560e3578ef7f&_include=Patient:link`,
      null,
      JSON.stringify({ entry: patient1AndLink.entry.concat(patient2AndLink.entry) })
    );
    // linked to a third golden record, so it is not promoted into the auto matches
    request.__setFhirResults(
      `${FHIR_BASE_URL}/Patient?_id=${potentialId}`,
      null,
      JSON.stringify({ entry: [{ resource: {
        resourceType: "Patient",
        id: potentialId,
        meta: { tag: [] },
        link: [{ other: { reference: "Patient/42184bd9-1c0c-41ce-9188-f57341ca9e88" } }]
      } }] })
    );

    return supertest(app)
      .post("/resolve-match-issue").send(resolveIssuesReqBundle).then( (response) => {
        expect(response.statusCode).toBe(200);
        expect(tagsLastSavedOn("433ebeb6-1d89-4b64-97e6-a985675ca571")).toEqual([
          "http://openclientregistry.org/fhir/clientid|openmrs",
          "http://openclientregistry.org/fhir/matchIssues|potentialMatches",
          "http://openclientregistry.org/fhir/automatch|autoMatches",
          "http://openclientregistry.org/fhir/matchIssues|conflictMatches"
        ]);
    } );
  });

  // Anything sitting in the match issues queue is already flagged, so the conflict that survives
  // resolving must not add a second tag.
  test( "Testing Resolving Match Issues Does Not Repeat An Existing Conflict Flag", () => {
    const resolveIssuesReqBundle = require("./otherResources/requestResolveIssue.json");
    const allMatchIssuesWithLinks = JSON.parse(JSON.stringify(
      require("./FHIRResources/allMatchIssuesWithLinks.json")
    ));
    const patient1AndLink = require("./FHIRResources/patient1andlinkAfterBrokenMatchWithoutRematch.json");
    const patient2AndLink = require("./FHIRResources/patient2andlinkAfterBrokenMatchWithoutRematch.json");
    const decisionRules = config.get("rules");
    const resolvingFrom = allMatchIssuesWithLinks.entry.find((entry) => {
      return entry.resource.id === "433ebeb6-1d89-4b64-97e6-a985675ca571";
    }).resource;
    resolvingFrom.meta.tag.push({
      system: "http://openclientregistry.org/fhir/matchIssues",
      code: "conflictMatches",
      display: "Conflict On Match"
    });

    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?_id=433ebeb6-1d89-4b64-97e6-a985675ca571,c49a52c1-88bc-41fb-9c87-bdd2a911f360,739d4023-40eb-4f44-8d14-3355926bd60d,bc58707b-62f1-498a-8fb3-568cd5b69db2,d55e15fd-d7a6-42b8-89cc-560e3578ef7f`, null, JSON.stringify(
      allMatchIssuesWithLinks
    ) );
    axios.__setFhirResults(
      `${ES_BASE_URL}/_search?scroll=1m&size=1000`,
      buildQuery(resolvingFrom, decisionRules[0]),
      esSearchResults([
        esHit("bc58707b-62f1-498a-8fb3-568cd5b69db2", decisionRules[0].autoMatchThreshold),
        esHit("d55e15fd-d7a6-42b8-89cc-560e3578ef7f", decisionRules[0].autoMatchThreshold)
      ])
    );
    request.__setFhirResults(
      `${FHIR_BASE_URL}/Patient?_id=bc58707b-62f1-498a-8fb3-568cd5b69db2,d55e15fd-d7a6-42b8-89cc-560e3578ef7f&_include=Patient:link`,
      null,
      JSON.stringify({ entry: patient1AndLink.entry.concat(patient2AndLink.entry) })
    );

    return supertest(app)
      .post("/resolve-match-issue").send(resolveIssuesReqBundle).then( (response) => {
        expect(response.statusCode).toBe(200);
        expect(tagsLastSavedOn("433ebeb6-1d89-4b64-97e6-a985675ca571")).toEqual([
          "http://openclientregistry.org/fhir/clientid|openmrs",
          "http://openclientregistry.org/fhir/matchIssues|conflictMatches",
          "http://openclientregistry.org/fhir/automatch|autoMatches",
          "http://openclientregistry.org/fhir/humanAdjudication|humanAdjudication"
        ]);
    } );
  });

  // The conflicts the length test reads are the reported conflicts and the auto matches together,
  // minus everything now hanging off the CRUID the patient was moved to. Here every auto match sits
  // on that CRUID and performMatch reports no conflict of its own, so the set empties and the flag
  // comes off.
  test( "Testing Resolving Match Issues Clears A Conflict Flag Once Every Auto Match Sits On The New CRUID", () => {
    const resolveIssuesReqBundle = require("./otherResources/requestResolveIssue.json");
    const allMatchIssuesWithLinks = JSON.parse(JSON.stringify(
      require("./FHIRResources/allMatchIssuesWithLinks.json")
    ));
    const decisionRules = config.get("rules");
    const newCRUID = "739d4023-40eb-4f44-8d14-3355926bd60d";
    const resolvingFrom = allMatchIssuesWithLinks.entry.find((entry) => {
      return entry.resource.id === "433ebeb6-1d89-4b64-97e6-a985675ca571";
    }).resource;
    resolvingFrom.meta.tag.push({
      system: "http://openclientregistry.org/fhir/matchIssues",
      code: "conflictMatches",
      display: "Conflict On Match"
    });
    const linkedToNewCRUID = (id) => {
      return {
        search: { mode: "match" },
        resource: {
          resourceType: "Patient",
          id,
          meta: { tag: [] },
          link: [{ other: { reference: `Patient/${newCRUID}` } }]
        }
      };
    };

    request.__setFhirResults( `${FHIR_BASE_URL}/Patient?_id=433ebeb6-1d89-4b64-97e6-a985675ca571,c49a52c1-88bc-41fb-9c87-bdd2a911f360,739d4023-40eb-4f44-8d14-3355926bd60d,bc58707b-62f1-498a-8fb3-568cd5b69db2,d55e15fd-d7a6-42b8-89cc-560e3578ef7f`, null, JSON.stringify(
      allMatchIssuesWithLinks
    ) );
    axios.__setFhirResults(
      `${ES_BASE_URL}/_search?scroll=1m&size=1000`,
      buildQuery(resolvingFrom, decisionRules[0]),
      esSearchResults([
        esHit("bc58707b-62f1-498a-8fb3-568cd5b69db2", decisionRules[0].autoMatchThreshold),
        esHit("d55e15fd-d7a6-42b8-89cc-560e3578ef7f", decisionRules[0].autoMatchThreshold)
      ])
    );
    request.__setFhirResults(
      `${FHIR_BASE_URL}/Patient?_id=bc58707b-62f1-498a-8fb3-568cd5b69db2,d55e15fd-d7a6-42b8-89cc-560e3578ef7f&_include=Patient:link`,
      null,
      JSON.stringify({ entry: [
        linkedToNewCRUID("bc58707b-62f1-498a-8fb3-568cd5b69db2"),
        linkedToNewCRUID("d55e15fd-d7a6-42b8-89cc-560e3578ef7f")
      ] })
    );

    return supertest(app)
      .post("/resolve-match-issue").send(resolveIssuesReqBundle).then( (response) => {
        expect(response.statusCode).toBe(200);
        // humanAdjudication arrives twice because the potential and conflict handlers each splice
        // and push against the same array. FHIR meta.tag is a set keyed by system and code, so a
        // real server stores one; asserting the sent array keeps the mock honest about what is sent.
        expect(tagsLastSavedOn("433ebeb6-1d89-4b64-97e6-a985675ca571")).toEqual([
          "http://openclientregistry.org/fhir/clientid|openmrs",
          "http://openclientregistry.org/fhir/automatch|autoMatches",
          "http://openclientregistry.org/fhir/humanAdjudication|humanAdjudication",
          "http://openclientregistry.org/fhir/humanAdjudication|humanAdjudication"
        ]);
    } );
  });
} );
