var Sequelize = require('sequelize');
var async = require('async');
var fs = require('fs');
var dialects = require('./dialects');
var _ = Sequelize.Utils._;

function AutoSequelize(database, username, password, options) {
  this.sequelize = new Sequelize(database, username, password, options || {});
  this.queryInterface = this.sequelize.getQueryInterface();
  this.options = {};
}

AutoSequelize.prototype.run = function(options, callback) {
 
  var self = this;
  var text = {};
  var tables = [];
  var _tables = {};
  var _foreignKeys = {};
  var dialect = dialects[self.sequelize.options.dialect]

  if (typeof options === "function") {
    callback = options;
    options = {};
  }

  options.global = options.global || 'Sequelize';
  options.local = options.local || 'sequelize';
  options.spaces = options.spaces || false;
  options.indentation = options.indentation || 1;
  options.directory = options.directory || './models';
  options.additional = options.additional || {}
  options.additional.freezeTableName = ! _.isUndefined(options.additional.freezeTableName) ? options.additional.freezeTableName : true

  self.options = options;
  
  // models files  ([tablename].js)
  this.queryInterface.showAllTables().then(function (__tables) {
    if(self.sequelize.options.dialect == 'mssql') __tables = _.map(__tables, 'tableName');
    tables = options.tables ? _.intersection(__tables, options.tables) : __tables;
    async.each(tables, mapForeignKeys, mapTables)
  });
  
  // models+assoc files  ([tablename].model.js)
  this.queryInterface.showAllTables().then(function (__tables) {
    if(self.sequelize.options.dialect == 'mssql') __tables = _.map(__tables, 'tableName');
    tables = options.tables ? _.intersection(__tables, options.tables) : __tables;
    async.each(tables, mapForeignKeys2, mapTables2)
  });
  
  // repositories files ([tablename].repository.js)
  this.queryInterface.showAllTables().then(function (__tables) {
    if(self.sequelize.options.dialect == 'mssql') __tables = _.map(__tables, 'tableName');
    tables = options.tables ? _.intersection(__tables, options.tables) : __tables;
    async.each(tables, mapForeignKeys3, mapTables3)
  });

  // Haxe typedefs files (DB__[tablename].hx)
  this.queryInterface.showAllTables().then(function (__tables) {
    if(self.sequelize.options.dialect == 'mssql') __tables = _.map(__tables, 'tableName');
    tables = options.tables ? _.intersection(__tables, options.tables) : __tables;
    async.each(tables, mapForeignKeys4, mapTables4)
  });


  function mapForeignKeys(table, fn) {
    if (! dialect) return fn()

    var sql = dialect.getForeignKeysQuery(table, self.sequelize.config.database)

    self.sequelize.query(sql, {type: self.sequelize.QueryTypes.SELECT, raw: true}).then(function (res) {
      _.each(res, function (ref) {
        var sourceColumn = ref.source_column || ref.from || "";
        var targetColumn = ref.target_column || ref.to || "";
        var targetTable  = ref.target_table || ref.table || "";
        var isForeignKey = ! _.isEmpty(_.trim(sourceColumn)) && ! _.isEmpty(_.trim(targetColumn));
        var isPrimaryKey = _.isFunction(dialect.isPrimaryKey) && dialect.isPrimaryKey(ref);

        // map sqlite's PRAGMA results
        ref = _.assign(ref, {
          source_table: table,
          source_column: sourceColumn,
          target_table: targetTable,
          target_column: targetColumn,
          isForeignKey : isForeignKey,
          isPrimaryKey: isPrimaryKey
        });

        if (isForeignKey || isPrimaryKey) {
          _foreignKeys[table] = _foreignKeys[table] || {}
          _foreignKeys[table][sourceColumn] = ref
        }
      });

      fn()
    }, mapTables);
  }

  function mapTables(err) {
    if (err) console.error(err)

    async.each(tables, mapTable, generateText)
  }

  function mapTable(table, _callback){
    self.queryInterface.describeTable(table).then(function(fields) {
      _tables[table] = fields
      _callback(null);
    }, _callback);
  }

  function generateText(err) {
    if (err) console.error(err)

    var tableNames = _.keys(_tables);
    async.each(tableNames, function(table, _callback){
      var fields = _.keys(_tables[table])
        , spaces = '';
      
      for (var x = 0; x < options.indentation; ++x) {
        spaces += (options.spaces === true ? ' ' : "\t");
      }

      text[table] = "module.exports = function(sequelize, DataTypes) {\n";
      text[table] += spaces + "return sequelize.define('" + table + "', {\n";

      _.each(fields, function(field, i){
        // Find foreign key
        var foreignKey = _foreignKeys[table] && _foreignKeys[table][field] ? _foreignKeys[table][field] : null
        if (_.isObject(foreignKey)) {
          _tables[table][field].foreignKey = foreignKey
        }

        // column's attributes
        var fieldAttr = _.keys(_tables[table][field]);

        text[table] += spaces + spaces + field + ": {\n";

        if (i==0) {
                text[table] += spaces + spaces + spaces + "primaryKey: true,\n";
        }

        // Serial key for postgres...
        var defaultVal = _tables[table][field].defaultValue;

        // ENUMs for postgres...
        if (_tables[table][field].type === "USER-DEFINED" && !! _tables[table][field].special) {
          _tables[table][field].type = "ENUM(" + _tables[table][field].special.map(function(f){ return "'" + f + "'"; }).join(',') + ")";
        }

        _.each(fieldAttr, function(attr, x){
          var isSerialKey = _tables[table][field].foreignKey && _.isFunction(dialect.isSerialKey) && dialect.isSerialKey(_tables[table][field].foreignKey)

          // We don't need the special attribute from postgresql describe table..
          if (attr === "special") {
            return true;
          }

          if (attr === "foreignKey") {
            if (isSerialKey) {
              text[table] += spaces + spaces + spaces + "autoIncrement: true";
            } else {
              text[table] += spaces + spaces + spaces + "references: {\n";
              text[table] += spaces + spaces + spaces + spaces + "model: \'" + _tables[table][field][attr].target_table + "\',\n"
              text[table] += spaces + spaces + spaces + spaces + "key: \'" + _tables[table][field][attr].target_column + "\'\n"
              text[table] += spaces + spaces + spaces + "}"
            }
          }
          else if (attr === "primaryKey") {
             if (_tables[table][field][attr] === true && _tables[table][field].hasOwnProperty('foreignKey') && !!_tables[table][field].foreignKey.isPrimaryKey)
              text[table] += spaces + spaces + spaces + "primaryKey: true";
            else return true
          }
          else if (attr === "allowNull") {
            text[table] += spaces + spaces + spaces + attr + ": " + _tables[table][field][attr];
          }
          else if (attr === "defaultValue") {
            var val_text = defaultVal;

            if (isSerialKey) return true

            if (_.isString(defaultVal)) {
              val_text = "'" + val_text + "'"
            }
            if(defaultVal === null) {
              return true;
            } else {
              text[table] += spaces + spaces + spaces + attr + ": " + val_text;
            }
          }
          else if (attr === "type" && _tables[table][field][attr].indexOf('ENUM') === 0) {
            text[table] += spaces + spaces + spaces + attr + ": DataTypes." + _tables[table][field][attr];
          } else {
            var _attr = (_tables[table][field][attr] || '').toLowerCase();
            var val = "'" + _tables[table][field][attr] + "'";
            if (_attr === "tinyint(1)" || _attr === "boolean") {
              val = 'DataTypes.BOOLEAN';
            }
            else if (_attr.match(/^(smallint|mediumint|tinyint|int)/)) {
              var length = _attr.match(/\(\d+\)/);
              val = 'DataTypes.INTEGER' + (!!length ? length : '');
            }
            else if (_attr.match(/^bigint/)) {
              val = 'DataTypes.BIGINT';
            }
            else if (_attr.match(/^string|varchar|varying|nvarchar/)) {
              val = 'DataTypes.STRING';
            }
            else if (_attr.match(/text|ntext$/)) {
              val = 'DataTypes.TEXT';
            }
            else if (_attr.match(/^(date|time)/)) {
              val = 'DataTypes.DATE';
            }
            else if (_attr.match(/^(float|float4)/)) {
              val = 'DataTypes.FLOAT';
            }
            else if (_attr.match(/^decimal/)) {
              val = 'DataTypes.DECIMAL';
            }
            else if (_attr.match(/^(float8|double precision)/)) {
              val = 'DataTypes.DOUBLE';
            }
            else if (_attr.match(/^uuid/)) {
              val = 'DataTypes.UUIDV4';
            }
            else if (_attr.match(/^json/)) {
              val = 'DataTypes.JSON';
            }
            else if (_attr.match(/^jsonb/)) {
              val = 'DataTypes.JSONB';
            }
            else if (_attr.match(/^geometry/)) {
              val = 'DataTypes.GEOMETRY';
            }
            text[table] += spaces + spaces + spaces + attr + ": " + val;
          }

          text[table] += ",";
          text[table] += "\n";
        });

        // removes the last `,` within the attribute options
        text[table] = text[table].trim().replace(/,+$/, '') + "\n";

        text[table] += spaces + spaces + "}";
        if ((i+1) < fields.length) {
          text[table] += ",";
        }
        text[table] += "\n";
      });

      text[table] += spaces + "}";

      //conditionally add additional options to tag on to orm objects
      var hasadditional = _.isObject(options.additional) && _.keys(options.additional).length > 0;

      text[table] += ", {\n";

      text[table] += spaces + spaces  + "tableName: '" + table + "',\n";

      if (hasadditional) {
        _.each(options.additional, addAdditionalOption)
      }

      text[table] = text[table].trim()
      text[table] = text[table].substring(0, text[table].length - 1);
      text[table] += "\n" + spaces + "}";

      function addAdditionalOption(value, key) {
        text[table] += spaces + spaces + key + ": " + value + ",\n";
      }

      //resume normal output
      text[table] += ");\n};\n";
      _callback(null);
    }, function(){
      self.sequelize.close();

      self.write(text, callback);
    });
  }

  function mapForeignKeys2(table, fn) {
    if (! dialect) return fn()

    var sql = dialect.getForeignKeysQuery(table, self.sequelize.config.database)

    self.sequelize.query(sql, {type: self.sequelize.QueryTypes.SELECT, raw: true}).then(function (res) {
      _.each(res, function (ref) {
        var sourceColumn = ref.source_column || ref.from || "";
        var targetColumn = ref.target_column || ref.to || "";
        var targetTable  = ref.target_table || ref.table || "";
        var isForeignKey = ! _.isEmpty(_.trim(sourceColumn)) && ! _.isEmpty(_.trim(targetColumn));
        var isPrimaryKey = _.isFunction(dialect.isPrimaryKey) && dialect.isPrimaryKey(ref);

        // map sqlite's PRAGMA results
        ref = _.assign(ref, {
          source_table: table,
          source_column: sourceColumn,
          target_table: targetTable,
          target_column: targetColumn,
          isForeignKey : isForeignKey,
          isPrimaryKey: isPrimaryKey
        });

        if (isForeignKey || isPrimaryKey) {
          _foreignKeys[table] = _foreignKeys[table] || {}
          _foreignKeys[table][sourceColumn] = ref
        }
      });

      fn()
    }, mapTables2);
  }


  function mapTables2(err) {
    if (err) console.error(err)

    async.each(tables, mapTable2, generateText2)

  }

  function mapTable2(table, _callback){
    self.queryInterface.describeTable(table).then(function(fields) {
      _tables[table] = fields
      _callback(null);
    }, _callback);
  }

  function generateText2(err) {
    if (err) console.error(err)

    var tableNames = _.keys(_tables);
    async.each(tableNames, function(table, _callback){
      text[table] ="";
      var fields = _.keys(_tables[table])
        , spaces = '';
      
      for (var x = 0; x < options.indentation; ++x) {
        spaces += (options.spaces === true ? ' ' : "\t");
      }
            text[table] = spaces + spaces +"module.exports = function(sequelize) {\n";
            text[table] += spaces + spaces + spaces + "var m = sequelize.import('./"+table+".js');\n";

      _.each(fields, function(field, i){
        // Find foreign key
        var foreignKey = _foreignKeys[table] && _foreignKeys[table][field] ? _foreignKeys[table][field] : null
        if (_.isObject(foreignKey)) {
          _tables[table][field].foreignKey = foreignKey
        }

        // column's attributes
        var fieldAttr = _.keys(_tables[table][field]);

        _.each(fieldAttr, function(attr, x){
          var isSerialKey = _tables[table][field].foreignKey && _.isFunction(dialect.isSerialKey) && dialect.isSerialKey(_tables[table][field].foreignKey);

          if (attr === "foreignKey") {
            if (isSerialKey) {
              //
            } else {

            text[table] += spaces + spaces + spaces + "var "+_tables[table][field][attr].target_table+" = sequelize.import('./"+_tables[table][field][attr].target_table+".js');\n";
            text[table] += spaces + spaces + spaces + "m.hasOne("+_tables[table][field][attr].target_table+", { as: '"+_tables[table][field][attr].target_table+"', foreignKey: '"+_tables[table][field][attr].target_column+"'});\n";
           }
          }

        });
      });

            text[table] += spaces + spaces + spaces + "return m;\n";
            text[table] += spaces + spaces + "};\n";
      _callback(null);
    }, function(){
      self.sequelize.close();
      self.write2(text, callback);
    });
  }

function mapForeignKeys4(table, fn) {
    if (! dialect) return fn()

    var sql = dialect.getForeignKeysQuery(table, self.sequelize.config.database)

    self.sequelize.query(sql, {type: self.sequelize.QueryTypes.SELECT, raw: true}).then(function (res) {
      _.each(res, function (ref) {
        var sourceColumn = ref.source_column || ref.from || "";
        var targetColumn = ref.target_column || ref.to || "";
        var targetTable  = ref.target_table || ref.table || "";
        var isForeignKey = ! _.isEmpty(_.trim(sourceColumn)) && ! _.isEmpty(_.trim(targetColumn));
        var isPrimaryKey = _.isFunction(dialect.isPrimaryKey) && dialect.isPrimaryKey(ref);

        // map sqlite's PRAGMA results
        ref = _.assign(ref, {
          source_table: table,
          source_column: sourceColumn,
          target_table: targetTable,
          target_column: targetColumn,
          isForeignKey : isForeignKey,
          isPrimaryKey: isPrimaryKey
        });

        if (isForeignKey || isPrimaryKey) {
          _foreignKeys[table] = _foreignKeys[table] || {}
          _foreignKeys[table][sourceColumn] = ref
        }
      });

      fn()
    }, mapTables4);
  }

  function mapForeignKeys3(table, fn) {
    if (! dialect) return fn()

    var sql = dialect.getForeignKeysQuery(table, self.sequelize.config.database)

    self.sequelize.query(sql, {type: self.sequelize.QueryTypes.SELECT, raw: true}).then(function (res) {
      _.each(res, function (ref) {
        var sourceColumn = ref.source_column || ref.from || "";
        var targetColumn = ref.target_column || ref.to || "";
        var targetTable  = ref.target_table || ref.table || "";
        var isForeignKey = ! _.isEmpty(_.trim(sourceColumn)) && ! _.isEmpty(_.trim(targetColumn));
        var isPrimaryKey = _.isFunction(dialect.isPrimaryKey) && dialect.isPrimaryKey(ref);

        // map sqlite's PRAGMA results
        ref = _.assign(ref, {
          source_table: table,
          source_column: sourceColumn,
          target_table: targetTable,
          target_column: targetColumn,
          isForeignKey : isForeignKey,
          isPrimaryKey: isPrimaryKey
        });

        if (isForeignKey || isPrimaryKey) {
          _foreignKeys[table] = _foreignKeys[table] || {}
          _foreignKeys[table][sourceColumn] = ref
        }
      });

      fn()
    }, mapTables3);
  }


  function mapTables3(err) {
    if (err) console.error(err)

    async.each(tables, mapTable3, generateText3)

  }

  function mapTable3(table, _callback){
    self.queryInterface.describeTable(table).then(function(fields) {
      _tables[table] = fields
      _callback(null);
    }, _callback);
  }

  function generateText3(err) {
    if (err) console.error(err)

    var tableNames = _.keys(_tables);
    async.each(tableNames, function(table, _callback){
      text[table] ="";
      var fields = _.keys(_tables[table])
        , spaces = '';
      
      for (var x = 0; x < options.indentation; ++x) {
        spaces += (options.spaces === true ? ' ' : "\t");
      }

            text[table] = spaces + spaces +"module.exports = function(sequelize) {\n";
            text[table] += spaces + spaces + spaces + "var m = sequelize.import('./"+table+".model.js');\n";
 
      _.each(fields, function(field, i){
        // Find foreign key
        var foreignKey = _foreignKeys[table] && _foreignKeys[table][field] ? _foreignKeys[table][field] : null
        if (_.isObject(foreignKey)) {
          _tables[table][field].foreignKey = foreignKey
        }

        // column's attributes
        var fieldAttr = _.keys(_tables[table][field]);

        _.each(fieldAttr, function(attr, x){
          var isSerialKey = _tables[table][field].foreignKey && _.isFunction(dialect.isSerialKey) && dialect.isSerialKey(_tables[table][field].foreignKey);

          if (attr === "foreignKey") {
            if (isSerialKey) {
              //
            } else {
           text[table] += spaces + spaces + spaces + "var p = sequelize.import('./"+_tables[table][field][attr].target_table+".model.js');\n";
            text[table] += spaces + spaces + spaces + "m.findWith_"+_tables[table][field][attr].target_table+" = function(limit) {\n";
            text[table] += spaces + spaces + spaces + spaces + "m.findAll({\n";                  
            text[table] += spaces + spaces + spaces + spaces + spaces + "include: [{ model: p, as: 'p' }],\n";                  
            text[table] += spaces + spaces + spaces + spaces + spaces + "limit: limit,\n";                  
            text[table] += spaces + spaces + spaces + spaces + spaces + "raw: true\n";                  
            text[table] += spaces + spaces + spaces + spaces + "})\n";                  
            text[table] += spaces + spaces + spaces + spaces + ".then(function(rows) {\n";                  
            text[table] += spaces + spaces + spaces + spaces + spaces+ "console.log(rows);\n";                  
            text[table] += spaces + spaces + spaces + spaces + "});\n";                  
            text[table] += spaces + spaces + spaces + "}\n";
           }
          }

        });
      });

            
            text[table] += spaces + spaces + "m.findWithAssoc = function(limit, order, cb) {\n";
            text[table] += spaces + spaces + "var pp=[];\n";
                _.each(fields, function(field, i){
                // Find foreign key
                var foreignKey = _foreignKeys[table] && _foreignKeys[table][field] ? _foreignKeys[table][field] : null
                if (_.isObject(foreignKey)) {
                  _tables[table][field].foreignKey = foreignKey
                }

                // column's attributes
                var fieldAttr = _.keys(_tables[table][field]);

                _.each(fieldAttr, function(attr, x){
                  var isSerialKey = _tables[table][field].foreignKey && _.isFunction(dialect.isSerialKey) && dialect.isSerialKey(_tables[table][field].foreignKey);

                  if (attr === "foreignKey") {
                    if (isSerialKey) {
                      //
                    } else {
                   text[table] += spaces + spaces + spaces + "var p = sequelize.import('./"+_tables[table][field][attr].target_table+".model.js');\n";
                    text[table] += spaces + spaces + spaces + "pp.push({ model: p, as: '"+_tables[table][field][attr].target_table+"' });\n";
                   }
                  }

                });
              });
                    text[table] += spaces + spaces + spaces + spaces + "m.findAll({\n";                  
                    text[table] += spaces + spaces + spaces + spaces + spaces + "include: pp,\n";                  
                    text[table] += spaces + spaces + spaces + spaces + spaces + "order: order,\n";                 
                    text[table] += spaces + spaces + spaces + spaces + spaces + "limit: limit,\n";                  
                    text[table] += spaces + spaces + spaces + spaces + spaces + "raw: true\n";                  
                    text[table] += spaces + spaces + spaces + spaces + "})\n";                  
                    text[table] += spaces + spaces + spaces + spaces + ".then(function(rows) {\n";                  
                    text[table] += spaces + spaces + spaces + spaces + spaces+ "cb(rows);\n";                  
                    text[table] += spaces + spaces + spaces + spaces + "});\n";                  
                    text[table] += spaces + spaces + "}\n";

                    text[table] += spaces + spaces + "m.findBy = function(attr, value, cb) {\n";
                    text[table] += spaces + spaces + spaces + spaces + "m.findAll({\n";            
                    text[table] += spaces + spaces + spaces + spaces + spaces + "where: {\n";
                    text[table] += spaces + spaces + spaces + spaces + spaces + "attr: value\n";
                    text[table] += spaces + spaces + spaces + spaces + spaces + "},\n";
                    text[table] += spaces + spaces + spaces + spaces + spaces + "limit: limit,\n";                  
                    text[table] += spaces + spaces + spaces + spaces + spaces + "raw: true\n";                  
                    text[table] += spaces + spaces + spaces + spaces + "})\n";                  
                    text[table] += spaces + spaces + spaces + spaces + ".then(function(rows) {\n";                  
                    text[table] += spaces + spaces + spaces + spaces + spaces+ "cb(rows);\n";                  
                    text[table] += spaces + spaces + spaces + spaces + "});\n";                  
                    text[table] += spaces + spaces + "}\n";



            text[table] += spaces + spaces + "return m;\n";

            text[table] += spaces + spaces + "};\n";
      _callback(null);
    }, function(){
      self.sequelize.close();
      self.write3(text, callback);
    });
  }







function mapTables4(err) {
    if (err) console.error(err)

    async.each(tables, mapTable4, generateText4)

  }

  function mapTable4(table, _callback){
    self.queryInterface.describeTable(table).then(function(fields) {
      _tables[table] = fields
      _callback(null);
    }, _callback);
  }

  function generateText4(err) {
    if (err) console.error(err)

    var tableNames = _.keys(_tables);
    async.each(tableNames, function(table, _callback){
      var fields = _.keys(_tables[table])
        , spaces = '';
      
      for (var x = 0; x < options.indentation; ++x) {
        spaces += (options.spaces === true ? ' ' : "\t");
      }

      text[table] = "typedef DB__" + table + " = {\n";

      _.each(fields, function(field, i){
        // Find foreign key
        var foreignKey = _foreignKeys[table] && _foreignKeys[table][field] ? _foreignKeys[table][field] : null
        if (_.isObject(foreignKey)) {
          _tables[table][field].foreignKey = foreignKey
        }

        // column's attributes
        var fieldAttr = _.keys(_tables[table][field]);


        // Serial key for postgres...
        var defaultVal = _tables[table][field].defaultValue;

        // ENUMs for postgres...
        if (_tables[table][field].type === "USER-DEFINED" && !! _tables[table][field].special) {
          _tables[table][field].type = "ENUM(" + _tables[table][field].special.map(function(f){ return "'" + f + "'"; }).join(',') + ")";
        }

        _.each(fieldAttr, function(attr, x){
          var isSerialKey = _tables[table][field].foreignKey && _.isFunction(dialect.isSerialKey) && dialect.isSerialKey(_tables[table][field].foreignKey)

          // We don't need the special attribute from postgresql describe table..
          if (attr === "special") {
            return true;
          }

          if (attr === "foreignKey") {
          }
          else if (attr === "primaryKey") {
          }
          else if (attr === "allowNull") {
          }
          else if (attr === "defaultValue") {
          }
          else if (attr === "type" && _tables[table][field][attr].indexOf('ENUM') === 0) {
          } else {
            var _attr = (_tables[table][field][attr] || '').toLowerCase();
            var val = "'" + _tables[table][field][attr] + "'";
            if (_attr === "tinyint(1)" || _attr === "boolean") {
              val = 'Bool';
            }
            else if (_attr.match(/^(smallint|mediumint|tinyint|int)/)) {
              var length = _attr.match(/\(\d+\)/);
              val = 'Int' + (!!length ? length : '');
            }
            else if (_attr.match(/^bigint/)) {
              val = 'Int';
            }
            else if (_attr.match(/^string|varchar|varying|nvarchar/)) {
              val = 'String';
            }
            else if (_attr.match(/text|ntext$/)) {
              val = 'String';
            }
            else if (_attr.match(/^(date|time)/)) {
              val = 'Date';
            }
            else if (_attr.match(/^(float|float4)/)) {
              val = 'Float';
            }
            else if (_attr.match(/^decimal/)) {
              val = 'Float';
            }
            else if (_attr.match(/^(float8|double precision)/)) {
              val = 'Float';
            }
            else  val = 'Bool'; // TODO : remove this case and fill all cases ! Bool is not always true !
/*
            else if (_attr.match(/^uuid/)) {
              val = 'String';
            }
            else if (_attr.match(/^json/)) {
              val = 'DataTypes.JSON';
            }
            else if (_attr.match(/^jsonb/)) {
              val = 'DataTypes.JSONB';
            }
            else if (_attr.match(/^geometry/)) {
              val = 'DataTypes.GEOMETRY';
            }
*/
            text[table] += spaces + spaces + field + ": " + val;
          }

        });

        if ((i+1) < fields.length) {
          text[table] += ",\n";
        }
      });
        text[table] += "\n};\n";

      _callback(null);
    }, function(){
      self.sequelize.close();

      self.write4(text, callback);
    });
  }
}

AutoSequelize.prototype.write2 = function(attributes, callback) {
  var tables = _.keys(attributes);
  var self = this;

  async.series([findOrCreateDirectory], writeFile);

  function findOrCreateDirectory(_callback){
    fs.lstat(self.options.directory, function(err, stat){
      if (err || !stat.isDirectory()) {
        fs.mkdir(self.options.directory, _callback);
      } else {
        _callback(null);
      }
    })
  }

  function writeFile(err) {
    if (err) return callback(err);

    async.each(tables, createFile, callback)
  }

  function createFile(table, _callback){
    //console.log(attributes[table]);
    fs.writeFile(self.options.directory + '/' + table + '.model.js', attributes[table], _callback);
  }
}

AutoSequelize.prototype.write = function(attributes, callback) {
  var tables = _.keys(attributes);
  var self = this;

  async.series([findOrCreateDirectory], writeFile);

  function findOrCreateDirectory(_callback){
    fs.lstat(self.options.directory, function(err, stat){
      if (err || !stat.isDirectory()) {
        fs.mkdir(self.options.directory, _callback);
      } else {
        _callback(null);
      }
    })
  }

  function writeFile(err) {
    if (err) return callback(err);

    async.each(tables, createFile, callback)
  }

  function createFile(table, _callback){
    fs.writeFile(self.options.directory + '/' + table + '.js', attributes[table], _callback);
  }
}

AutoSequelize.prototype.write3 = function(attributes, callback) {
  var tables = _.keys(attributes);
  var self = this;

  async.series([findOrCreateDirectory], writeFile);

  function findOrCreateDirectory(_callback){
    fs.lstat(self.options.directory, function(err, stat){
      if (err || !stat.isDirectory()) {
        fs.mkdir(self.options.directory, _callback);
      } else {
        _callback(null);
      }
    })
  }

  function writeFile(err) {
    if (err) return callback(err);

    async.each(tables, createFile, callback)
  }

  function createFile(table, _callback){
    fs.writeFile(self.options.directory + '/' + table + '.repository.js', attributes[table], _callback);
  }
}


AutoSequelize.prototype.write4 = function(attributes, callback) {
  var tables = _.keys(attributes);
  var self = this;

  async.series([findOrCreateDirectory], writeFile);

  function findOrCreateDirectory(_callback){
    fs.lstat(self.options.directory, function(err, stat){
      if (err || !stat.isDirectory()) {
        fs.mkdir(self.options.directory, _callback);
      } else {
        _callback(null);
      }
    })
  }

  function writeFile(err) {
    if (err) return callback(err);

    async.each(tables, createFile, callback)
  }

  function createFile(table, _callback){
    fs.writeFile(self.options.directory + '/DB__' + table + '.hx', attributes[table], _callback);
  }
}

module.exports = AutoSequelize
