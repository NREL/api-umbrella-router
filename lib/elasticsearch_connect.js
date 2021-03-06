'use strict';

var _ = require('lodash'),
    async = require('async'),
    elasticsearch = require('elasticsearch'),
    fs = require('fs'),
    logger = require('./logger'),
    moment = require('moment'),
    path = require('path');

var ElasticSearchConnect = function() {
  this.initialize.apply(this, arguments);
};

var ElasticSearchBunyanLogger = function elasticSearchBunyanLogger() {
  this.error = logger.error.bind(logger);
  this.warning = logger.warn.bind(logger);
  this.info = logger.info.bind(logger);
  this.debug = logger.debug.bind(logger);
  this.trace = function (method, requestUrl, body, responseBody, responseStatus) {
    logger.trace({
      method: method,
      requestUrl: requestUrl,
      body: body,
      responseBody: responseBody,
      responseStatus: responseStatus
    });
  };
  this.close = function () { /* bunyan's loggers do not need to be closed */ };
};

_.extend(ElasticSearchConnect.prototype, {
  initialize: function(callback) {
    this.config = require('api-umbrella-config').global();
    this.callback = callback;

    // elasticsearch mutates the client config, so always work off a clone:
    // https://github.com/elasticsearch/elasticsearch-js/issues/33
    var clientConfig = _.cloneDeep(this.config.get('elasticsearch'));
    this.client = new elasticsearch.Client(_.merge(clientConfig, {
      log: ElasticSearchBunyanLogger,
      requestTimeout: 120000,
    }));

    async.series([
      this.waitForConnection.bind(this),
      this.deleteLegacyTemplates.bind(this),
      this.setupTemplates.bind(this),
      this.setupDefaultAliases.bind(this),
    ], this.finishConnect.bind(this));
  },

  waitForConnection: function(asyncReadyCallback) {
    var connected = false;
    var attempts = 0;
    var attemptDelay = 500;
    var maxAttempts = 120;
    var lastError;
    async.until(function() {
      return connected || attempts > maxAttempts;
    }, function(untilCallback) {
      this.client.ping({
        requestTimeout: 1000,
      }, function(error) {
        attempts++;
        if(!error) {
          connected = true;
          lastError = null;
          untilCallback();
        } else {
          lastError = error;
          setTimeout(untilCallback, attemptDelay);
        }
      });
    }.bind(this), function() {
      asyncReadyCallback(lastError);
    });
  },

  deleteLegacyTemplates: function(asyncReadyCallback) {
    var params = {
      name: 'api-umbrella-log-template',
    };

    // Ensure the legacy, unversioned template is deleted so multiple
    // matches don't occur. Going forward our templates contain version
    // numbers.
    this.client.indices.existsTemplate(params, function(error, exists) {
      if(error) { return asyncReadyCallback(error); }

      if(exists) {
        this.client.indices.deleteTemplate(params, asyncReadyCallback);
      } else {
        asyncReadyCallback(error);
      }
    }.bind(this));
  },

  setupTemplates: function(asyncReadyCallback) {
    var templatesPath = path.resolve(__dirname, '../config/elasticsearch_templates.json');
    fs.readFile(templatesPath, this.handleTemplates.bind(this, asyncReadyCallback));
  },

  handleTemplates: function(asyncReadyCallback, error, templates) {
    this.templates = JSON.parse(templates.toString());
    async.each(this.templates, this.uploadTemplate.bind(this), asyncReadyCallback);
  },

  uploadTemplate: function(template, callback) {
    this.client.indices.putTemplate({
      name: template.id,
      body: template.template,
    }, function(error) {
      if(error) {
        logger.error({ err: error }, 'Template error');
      }

      callback(null);
    });
  },

  setupDefaultAliases: function(asyncReadyCallback) {
    var today = moment().utc().format('YYYY-MM');
    var tomorrow = moment().add(1, 'days').utc().format('YYYY-MM');

    var aliases = _.uniq([
      {
        name: 'api-umbrella-logs-' + today,
        index: 'api-umbrella-logs-' + this.config.get('log_template_version') + '-' + today,
      },
      {
        name: 'api-umbrella-logs-write-' + today,
        index: 'api-umbrella-logs-' + this.config.get('log_template_version') + '-' + today,
      },
      {
        name: 'api-umbrella-logs-' + tomorrow,
        index: 'api-umbrella-logs-' + this.config.get('log_template_version') + '-' + tomorrow,
      },
      {
        name: 'api-umbrella-logs-write-' + tomorrow,
        index: 'api-umbrella-logs-' + this.config.get('log_template_version') + '-' + tomorrow,
      },
    ], 'name');

    async.each(aliases, this.createAlias.bind(this), function() {
      // Since we have dynamic, date-based indexes, we need to ensure that the
      // aliases for the current time are kept up to date. So keep re-running
      // the setup alias function to ensure that the aliases already exist
      // before the next month hits (otherwise, elasticsearch would end up
      // creating an actual index in place of the alias's name).
      this.setupDefaultAliasesTimeout = setTimeout(this.setupDefaultAliases.bind(this), 3600000);
      this.setupDefaultAliasesTimeout.unref();

      if(asyncReadyCallback) {
        asyncReadyCallback(null);
      }
    }.bind(this));
  },

  createAlias: function(alias, callback) {
    this.client.indices.existsAlias({
      name: alias.name,
    }, function(error, exists) {
      if(exists) {
        callback(error);
      } else {
        this.client.indices.create({
          index: alias.index,
        }, function() {
          this.client.indices.putAlias(alias, callback);
        }.bind(this));
      }
    }.bind(this));
  },

  finishConnect: function(error) {
    this.callback(error, this.client, this);
  },

  close: function() {
    if(this.setupDefaultAliasesTimeout) {
      clearTimeout(this.setupDefaultAliasesTimeout);
    }

    if(this.client) {
      this.client.close();
    }
  },
});

module.exports = function(callback) {
  new ElasticSearchConnect(callback);
};
