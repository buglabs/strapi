'use strict';

/**
 * Module dependencies
 */

// Node.js core.
const fs = require('fs-extra');
const path = require('path');

// Public dependencies
const _ = require('lodash');
const GraphQL = require('graphql');

// Local utilities.
const helpers = require('./helpers/');
const utils = require('./utils/');
const modelsUtils = require('../models/utils/');

/*
 * GraphQL schema
 */

module.exports = {

  /*
   * Defaults parameters object
   */

  defaults: {
    collections: {},
    usefulQueries: true
  },

  /*
   * Starter to manage conversion process and build valid GraphQL schemas
   */

  getGraphQLSchema: function (params, cb) {
    if (_.isEmpty(params.collections)) {
      return cb('GraphQL server has not been started because there are no models', null);
    }

    // Set defaults properties
    this.defaults = _.assign(this.defaults, params);

    const Query = this.getQueries();
    const Mutation = _.get(this.defaults, 'ignoreMutations') === true ? null : this.getMutations();

    const Schema = new GraphQL.GraphQLSchema(_.omit({
      query: Query,
      mutation: Mutation
    }, _.isNull));

    // Return schema
    cb(null, Schema);

    // Build policies
    this.buildPolicies();
  },

  /*
   * Build policies files
   */

  buildPolicies: function () {
    const self = this;

    _.forEach(this.defaults.collections, function (collection, rootKey) {
      // Identify queries related to this collection
      const queries = _.pickBy(self.defaults.queryFields, function (query, key) {
        if (key.indexOf(rootKey) !== -1 || key.indexOf(_.capitalize(rootKey)) !== -1) {
          return true;
        }
      });

      // Identify mutations related to this collection
      const mutations = _.pickBy(self.defaults.mutations, function (query, key) {
        if (key.indexOf(rootKey) !== -1 || key.indexOf(_.capitalize(rootKey)) !== -1) {
          return true;
        }
      });

      // Initialize query and mutations to empty array
      const value = {
        graphql: {
          queries: _.mapValues(queries, function () {
            return [];
          }),
          mutations: _.mapValues(mutations, function () {
            return [];
          })
        }
      };

      const rootValue = {
        graphql: _.get(strapi.api, rootKey + '.config.graphql') || {}
      }

      // Override or write file
      fs.writeJson(path.join(strapi.config.appPath, 'api', rootKey, 'config', 'graphql.json'), _.merge(value, rootValue), function (err) {
        if (err) {
          console.log(err);
        }
      });
    });
  },

  /*
   * Manager to create queries for each collection
   */

  getQueries: function () {
    const self = this;

    // Create required keys
    this.defaults.types = {};
    this.defaults.queryFields = {};
    this.defaults.functions = {};

    // Build Node Interface to expand compatibility
    this.buildNodeInterface();

    // Build functions object by ORM
    _.forEach(this.defaults.collections, function (collection, key) {
      self.buildFunctionsByORM(collection, key);
    });

    // Build GraphQL type system objects
    _.forEach(this.defaults.collections, function (collection, key) {
      self.buildType(collection, key);
    });

    // Build GraphQL query
    _.forEach(this.defaults.collections, function (collection, key) {
      self.buildQueryFields(collection, key);
    });

    // Build GraphQL query object
    return new GraphQL.GraphQLObjectType({
      name: 'Queries',
      description: 'Root of the Schema',
      fields: function () {
        return self.defaults.queryFields;
      }
    });
  },

  /*
   * Manager to create mutations for each collection
   */
  getMutations: function () {
    const self = this;

    // Create require key
    this.defaults.mutations = {};

    // Build GraphQL mutation
    _.forEach(this.defaults.collections, function (collection, key) {
      self.buildMutation(collection, key);
    });

    // Build GraphQL mutation object
    return new GraphQL.GraphQLObjectType({
      name: 'Mutations',
      description: 'Mutations of the Schema',
      fields: function () {
        return self.defaults.mutations;
      }
    });
  },

  /*
   * Create GraphQL type system from BookShelf collection
   */

  buildFunctionsByORM: function (collection, key) {
    const ORM = modelsUtils.getORM(key);

    if (!_.isUndefined(ORM) && _.isUndefined(_.get(this.defaults.functions, ORM))) {
      _.set(this.defaults.functions, ORM, require(path.resolve(strapi.config.appPath, 'node_modules', 'strapi-' + ORM, 'lib', 'utils', 'graphql')));
    }
  },

  /*
   * Create GraphQL type system from BookShelf collection
   */

  buildType: function (collection, key) {
    const self = this;
    const ORM = modelsUtils.getORM(key);
    const collectionIdentity = this.defaults.functions[ORM].getCollectionIdentity(collection);
    const collectionAttributes = collection._attributes;

    const Type = new GraphQL.GraphQLObjectType({
      name: _.capitalize(collectionIdentity),
      description: 'This represents a/an ' + _.capitalize(collectionIdentity),
      interfaces: [self.defaults.node],
      fields: function () {
        const fields = {};

        _.forEach(collectionAttributes, function (rules, key) {
          if (rules.hasOwnProperty('model')) {
            fields[key] = {
              type: self.defaults.types[_.capitalize(rules.model)],
              resolve: function (object) {
                const criteria = {};
                criteria[collection.primaryKey] = object[key][self.defaults.collections[rules.model].primaryKey];

                return self.defaults.queryFields[rules.model.toLowerCase()].resolve(object, criteria);
              }
            };
          } else if (rules.hasOwnProperty('collection')) {
            fields[key] = {
              type: new GraphQL.GraphQLList(self.defaults.types[_.capitalize(rules.collection)]),
              resolve: function (object) {
                const criteria = {};
                criteria[rules.via.toLowerCase()] = object[collection.primaryKey];

                return self.defaults.queryFields[rules.collection.toLowerCase() + 's'].resolve(object, {}, {
                  where: criteria
                });
              }
            };
          } else {
            fields[key] = {
              type: rules.required ? new GraphQL.GraphQLNonNull(helpers.convertToGraphQLQueryType(rules)) : helpers.convertToGraphQLQueryType(rules)
            };
          }
        });

        // Handle interface
        fields.id = {
          type: new GraphQL.GraphQLNonNull(GraphQL.GraphQLString)
        };

        fields.type = {
          type: new GraphQL.GraphQLNonNull(GraphQL.GraphQLString)
        };

        return fields;
      }
    });

    // Save to global parameters
    this.defaults.types[collectionIdentity] = Type;
  },

  /*
   * Create query framework for each collection
   */

  buildQueryFields: function (collection, key) {
    const self = this;
    const ORM = modelsUtils.getORM(key);
    const collectionIdentity = this.defaults.functions[ORM].getCollectionIdentity(collection);
    const fields = {};

    // Get single record
    fields[collectionIdentity.toLowerCase()] = {
      type: this.defaults.types[collectionIdentity],
      args: {
        id: {
          name: 'id',
          type: new GraphQL.GraphQLNonNull(GraphQL.GraphQLString)
        }
      },
      resolve: function (rootValue, criteria) {
        return utils.applyPolicies(rootValue, 'queries', collectionIdentity, collectionIdentity)
          .then(function () {
            return self.defaults.functions[ORM].fetch(collectionIdentity, collection, criteria);
          })
          .then(function (data) {
            return data;
          })
          .catch(function () {
            return null;
          });
      }
    };

    // Get multiples records
    fields[collectionIdentity.toLowerCase() + 's'] = {
      type: new GraphQL.GraphQLList(this.defaults.types[collectionIdentity]),
      args: {
        limit: {
          name: 'limit',
          type: GraphQL.GraphQLInt
        },
        skip: {
          name: 'skip',
          type: GraphQL.GraphQLInt
        },
        sort: {
          name: 'sort',
          type: GraphQL.GraphQLString
        }
      },
      resolve: function (rootValue, criteria) {
        return utils.applyPolicies(rootValue, 'queries', collectionIdentity, collectionIdentity + 's')
          .then(function () {
            return self.defaults.functions[ORM].fetchAll(collectionIdentity, collection, criteria);
          })
          .then(function (data) {
            return data;
          })
          .catch(function () {
            return null;
          });
      }
    };

    if (this.defaults.usefulQueries === true) {
      // Get latest records sorted by creation date
      fields['getLatest' + collectionIdentity + 's'] = {
        type: new GraphQL.GraphQLList(this.defaults.types[collectionIdentity]),
        args: {
          count: {
            name: 'count',
            type: new GraphQL.GraphQLNonNull(GraphQL.GraphQLInt)
          }
        },
        resolve: function (rootValue, criteria) {
          return utils.applyPolicies(rootValue, 'queries', collectionIdentity, 'getLatest' + collectionIdentity + 's')
            .then(function () {
              return self.defaults.functions[ORM].fetchLatest(collectionIdentity, collection, criteria);
            })
            .then(function (data) {
              return data;
            })
            .catch(function () {
              return null;
            });
        }
      };

      // Get first records sorted by creation date
      fields['getFirst' + collectionIdentity + 's'] = {
        type: new GraphQL.GraphQLList(this.defaults.types[collectionIdentity]),
        args: {
          count: {
            name: 'count',
            type: new GraphQL.GraphQLNonNull(GraphQL.GraphQLInt)
          }
        },
        resolve: function (rootValue, criteria) {
          return utils.applyPolicies(rootValue, 'queries', collectionIdentity, 'getFirst' + collectionIdentity + 's')
            .then(function () {
              return self.defaults.functions[ORM].fetchFirst(collectionIdentity, collection, criteria);
            })
            .then(function (data) {
              return data;
            })
            .catch(function () {
              return null;
            });
        }
      };

      // Get count of records
      fields['count' + collectionIdentity + 's'] = {
        type: GraphQL.GraphQLInt,
        resolve: function (rootValue) {
          return utils.applyPolicies(rootValue, 'queries', collectionIdentity, 'count' + collectionIdentity + 's')
            .then(function () {
              return self.defaults.functions[ORM].count(collectionIdentity, collection);
            })
            .then(function (data) {
              return data;
            })
            .catch(function () {
              return null;
            });

        }
      };
    }

    // Apply date filters to each query
    _.forEach(_.omit(fields, collectionIdentity.toLowerCase()), function (field) {
      if (_.isEmpty(field.args)) {
        field.args = {};
      }

      field.args.start = {
        name: 'start',
        type: GraphQL.GraphQLString
      };

      field.args.end = {
        name: 'end',
        type: GraphQL.GraphQLString
      };
    });

    _.assign(this.defaults.queryFields, fields);
  },

  /*
   * Create functions to do the same as an API
   */

  buildMutation: function (collection, key) {
    const self = this;
    const ORM = modelsUtils.getORM(key);
    const collectionIdentity = this.defaults.functions[ORM].getCollectionIdentity(collection);
    const collectionAttributes = collection._attributes;
    const PK = modelsUtils.getPK(collectionIdentity, collection);
    const fields = {};
    const args = {
      required: {},
      notRequired: {}
    };

    // Build args
    _.forEach(collectionAttributes, function (rules, key) {
      // Exclude relations
      if (!rules.hasOwnProperty('model') && !rules.hasOwnProperty('collection') && rules.required) {
        args.required[key] = {
          type: rules.required ? new GraphQL.GraphQLNonNull(helpers.convertToGraphQLQueryType(rules, self)) : helpers.convertToGraphQLQueryType(rules, self)
        };
      } else if (!rules.hasOwnProperty('model') && !rules.hasOwnProperty('collection') && !rules.required) {
        args.notRequired[key] = {
          type: helpers.convertToGraphQLQueryType(rules, self)
        };
      } else if (rules.required) {
        args.required[key] = {
          type: rules.required ? new GraphQL.GraphQLNonNull(helpers.convertToGraphQLRelationType(rules, self)) : helpers.convertToGraphQLRelationType(rules, self)
        };
      } else {
        args.notRequired[key] = {
          type: rules.required ? new GraphQL.GraphQLNonNull(helpers.convertToGraphQLRelationType(rules, self)) : helpers.convertToGraphQLRelationType(rules, self)
        };
      }
    });

    // Create record
    fields['create' + collectionIdentity] = {
      type: this.defaults.types[collectionIdentity],
      resolve: function (rootValue, args) {
        return utils.applyPolicies(rootValue, 'mutations', collectionIdentity, 'create' + collectionIdentity)
          .then(function () {
            return self.defaults.functions[ORM].create(collectionIdentity, rootValue, args);
          })
          .catch(function () {
            return null;
          });
      }
    };

    // Set primary key as required for update/delete mutation
    const argPK = _.set({}, PK, {
      type: new GraphQL.GraphQLNonNull(helpers.convertToGraphQLQueryType(PK))
    });

    // Update record(s)
    fields['update' + collectionIdentity] = {
      type: this.defaults.types[collectionIdentity],
      args: _.assign(args.required, argPK),
      resolve: function (rootValue, args) {
        return utils.applyPolicies(rootValue, 'mutations', collectionIdentity, 'update' + collectionIdentity)
          .then(function () {
            return self.defaults.functions[ORM].update(collectionIdentity, rootValue, args);
          })
          .then(function (data) {
            return data;
          })
          .catch(function () {
            return null;
          });
      }
    };

    // Delete record(s)
    fields['delete' + collectionIdentity] = {
      type: this.defaults.types[collectionIdentity],
      args: _.assign(args.notRequired, argPK),
      resolve: function (rootValue, args) {
        return utils.applyPolicies(rootValue, 'mutations', collectionIdentity, 'delete' + collectionIdentity)
          .then(function () {
            return self.defaults.functions[ORM].delete(collectionIdentity, rootValue, args);
          })
          .then(function (data) {
            return data;
          })
          .catch(function () {
            return null;
          });
      }
    };

    _.assign(this.defaults.mutations, fields);
  },

  /*
   * Build node interface
   */

  buildNodeInterface: function () {
    const self = this;

    this.defaults.node = new GraphQL.GraphQLInterfaceType({
      name: 'Node',
      description: 'An object with an ID',
      fields: function fields() {
        return {
          id: {
            type: new GraphQL.GraphQLNonNull(GraphQL.GraphQLString),
            description: 'The global unique ID of an object'
          },
          type: {
            type: new GraphQL.GraphQLNonNull(GraphQL.GraphQLString),
            description: 'The type of the object'
          }
        };
      },
      resolveType: function resolveType(object) {
        return object.type;
      }
    });

    this.defaults.nodeFields = {
      name: 'Node',
      type: this.defaults.node,
      description: 'A node interface field',
      args: {
        id: {
          type: new GraphQL.GraphQLNonNull(GraphQL.GraphQLString),
          description: 'Id of node interface'
        }
      },
      resolve: function resolve(object, criteria) {
        const arrayOfPromises = [];

        // Search value in each collection
        _.forEach(self.defaults.collections, function (collection) {
          arrayOfPromises.push(collection.find(criteria));
        });

        return Promise.all(arrayOfPromises)
          .then(function (results) {
            let typeIndex;
            let object;

            _.forEach(results, function (value, index) {
              if (_.size(value) === 1) {
                // Save the index
                typeIndex = index;

                // Get object from array
                object = _.first(value);

                return false;
              }
            });

            object.type = self.defaults.queryFields[_.keys(self.defaults.queryFields)[typeIndex]].type;

            return object;
          })
          .catch(function (error) {
            return error;
          });
      }
    };
  }
};