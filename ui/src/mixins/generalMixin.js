import axios from "axios";
export const generalMixin = {
  methods: {
    countMatchIssues() {
      axios.get(`/ocrux/match/count-match-issues`).then((response) => {
        if(response.data) {
          this.$store.state.totalMatchIssues = response.data.total
        }
      })
    },
    countNewAutoMatches() {
      axios.get(`/ocrux/match/count-new-auto-matches`).then((response) => {
        if(response.data) {
          this.$store.state.totalAutoMatches = response.data.total
        }
      })
    },
    // Every system that has contributed to a record, not just one. OpenCR appends a clientid tag
    // per contributing system, so a record created by a facility and later enriched by a batch feed
    // carries both; showing one made the other invisible.
    getSubmittingSystems(source) {
      let codes = [];
      if (Array.isArray(source)) {
        codes = source;
      } else if (source && source.meta && Array.isArray(source.meta.tag)) {
        codes = source.meta.tag
          .filter((tag) => tag.system === "http://openclientregistry.org/fhir/clientid")
          .map((tag) => tag.code);
      } else if (source) {
        codes = [source];
      }
      let names = [];
      for (let code of codes) {
        let name = this.getClientDisplayName(code) || code;
        if (name && names.indexOf(name) === -1) names.push(name);
      }
      return names.join(", ");
    },
    getClientDisplayName(clientid) {
      let clientDet = this.$store.state.clients.find((client) => {
        return client.id === clientid
      })
      if (clientDet) {
        return clientDet.displayName
      }
      return
    },
    getClients() {
      axios
        .get("/ocrux/config/getClients")
        .then(response => {
          this.$store.state.clients = response.data;
        })
        .catch(err => {
          throw err;
        });
    },
    getSystemURIDisplayName(systemURI) {
      if(systemURI === 'http://openclientregistry.org/fhir/sourceid') {
        return {
          name: 'Internal ID',
          id: 'internalid'
        }
      }
      let name, id
      for (let index in this.$store.state.systemURI) {
        let systemURIDet
        if (Array.isArray(this.$store.state.systemURI[index].uri)) {
          systemURIDet = this.$store.state.systemURI[index].uri.find((uri) => {
            return uri === systemURI
          })
        } else {
          if (this.$store.state.systemURI[index].uri === systemURI) {
            systemURIDet = systemURI
          }
        }
        if (systemURIDet) {
          name = this.$store.state.systemURI[index].displayName
          id = index
          break;
        }
      }
      return {
        name,
        id
      }
    }
  }
}