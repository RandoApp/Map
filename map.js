var log
var fs = require("fs");
var config = require("config");
var crypto = require("crypto");
var async = require("async");
var mapnik = require("mapnik");
var mercator = new (require("sphericalmercator"));
var gm = require("gm").subClass({ imageMagick: true });
var mkdirp = require("mkdirp");

var shpFiles = config.app.shpFiles;
shpFiles.push(config.app.shpPopulatedPlaceFile);

function checkData () {
    if (!config.app) {
		console.info("Config not found. Do you run script from root of project?\nnode map.js");
		process.exit(1);
    }

    for (var i = 0; i < shpFiles.length; i++) {
	    checkShpFile(config.app.shpFilesDir + shpFiles[i]);
    }
    checkPlacesJSON();
}

function checkShpFile(shpFile) {
	fs.exists(shpFile, function (exists) {
		if (!exists) {
			console.error("File " + shpFile + " not found.\n\nPlease, prepare map data before starting script:\n" +
				"mkdir " + config.app.tmpDir + "\n" +
				"cd " + config.app.tmpDir + "\n" + 
				"wget http://www.naturalearthdata.com/http//www.naturalearthdata.com/download/10m/cultural/10m_cultural.zip\n" +
				"wget http://www.naturalearthdata.com/http//www.naturalearthdata.com/download/10m/physical/10m_physical.zip\n" +
				"unzip 10m_cultural.zip\n" +
				"unzip 10m_physical.zip\n" +
				"");
			process.exit(1);
		}
	});
}

function checkPlacesJSON() {
	fs.exists(config.app.placesFile, function (exists) {
		if (!exists) {
			console.error("File " + config.app.placesFile + " not found.\n\nPlease, generate places file with ogr2ogr util from osci-libs/gdal package:\n" +
				"ogr2ogr -t_srs EPSG:4326 -f geoJSON " + config.app.placesFile + " " + config.app.shpFilesDir +  config.app.shpPopulatedPlaceFile + "\n" +
				"Read more about gdal(Geospatial Data Abstraction Library) here: www.gdal.orga");
			process.exit(1);
		}
	});
}

function mkTilesdir(done) {
	fs.mkdir(config.app.tmpTilesDir, function (err) {
		done(null);
	});
}

function cp(source, target, callback) {
	var sourceStream = fs.createReadStream(source);
	sourceStream.on("error", function (err) {
		callback(err);
	});

	var targetStream = fs.createWriteStream(target);
	targetStream.on("error", function (err) {
		callback(err);
	});

	targetStream.on("close", function (ex) {
		callback(null);
	});

	sourceStream.pipe(targetStream);
}

function copyStyleFiles(done) {
	cp(config.app.styleDir + config.app.marker, config.app.stylesheetTmpDir + config.app.marker, done);
}

function generateCitiesJSON(done) {
	async.waterfall([
		function (callback) {
			fs.readFile(config.app.placesFile, function (err, data) {
				if (err) {
					console.error("Can not read " + config.app.placesFile + " because: " + err);
					callback(err);
					return;
				}
				callback(null, JSON.parse(data));
			});
		},
		function (places, callback) {
			var cities = [];
			for (var i = 0; i < places.features.length; i++) {
				cities.push({
					"name": places.features[i].properties.nameascii,
					"latitude": places.features[i].properties.latitude,
					"longitude": places.features[i].properties.longitude
				});
			}
			callback(null, cities);
		}, 
		function (cities, callback) {
			fs.writeFile(config.app.citiesFile, JSON.stringify(cities), function (err) {
				if (err) {
					console.error("Can not write cities file: " + config.app.citiesFile + " because: " + err);
					callback(err);
					return;
				}
				cp(config.app.citiesFile, config.app.binDir.root + config.app.citiesSourceFile, function (err) {
					if (err) {
						callback(err);
						return;
					}

					callback(null, cities);
				});
			});
		}
	], function (err, cities) {
		if (err) {
			console.error("Cities json generation occured with error: " + err + "  TERMINATE script. Please, fix error and restart script again");
			process.exit(1);
		}
		done(null, cities);
	});
}

function loadStylesheetTemplate(cities, done) {
	var stylesheet = config.app.styleDir + config.app.stylesheet;
	fs.readFile(stylesheet, function (err, data) {
		if (err) {
			console.error("Can not read stylesheet " + stylesheet + " , because: " + err);
			done(err);
			return;
		}
		
		var stylesheetTemplate = String(data);
		for (var i = 0; i < shpFiles.length; i++) {
			stylesheetTemplate = stylesheetTemplate.replace(new RegExp(shpFiles[i], "g"), config.app.shpFilesDir + shpFiles[i]);
		}

		stylesheetTemplate = stylesheetTemplate.replace(new RegExp(config.app.key.marker, "g"), config.app.marker);

		done(null, cities, stylesheetTemplate);
	});
}

function prittyPrint(message, index, length, maxShift) {
	var shift = "";
	for (var i = 0; i < maxShift - message.length; i++) {
		shift += " ";
	}
	console.info(message + shift  + "[" + index + "|" + length + "]");
}

function renderTiles(cities, templateStylesheet, done) {
	var cityIndex = 0;
	async.eachLimit(cities, config.app.renderLimit, function (city, callback) {
		prittyPrint(city.name, cityIndex, cities.length, 30);
		cityIndex++;
		var tileName = crypto.createHash("md5").update(city.name + city.longitude + city.latitude).digest("hex");
		var cityStylesheet = templateStylesheet.replace(new RegExp(config.app.key.cityName, "g"), city.name.replace("'", "\\'"));
		var stylesheetFileName = config.app.stylesheetTmpDir + tileName + ".xml";
		fs.writeFileSync(stylesheetFileName, cityStylesheet);
		renderTile(stylesheetFileName, tileName, city.longitude, city.latitude, callback);
	}, function (err) {
		if (err) {
			console.error("Cities processed with error: " + err); 
			done(err);
			return;
		}
		done(null);
	});
}

function renderTile(stylesheet, tileName, longitude, latitude, done) {
	async.waterfall([
			function (callback) {
				mapnik.register_default_fonts();
				mapnik.register_default_input_plugins();

				var map = new mapnik.Map(config.app.imageSize.large, config.app.imageSize.large);
				map.load(stylesheet, function (err, map) {
					if (err) {
						console.error("Mapnik can not load stylesheet " +  stylesheet  + " , because: " + err);
						callback(err);
						return;
					}
					callback(null, map);
				});
			},
			function (map, callback) {
				var bbox = [];
				bbox = bbox.concat(mercator.forward([longitude - config.app.bboxSize, latitude + config.app.bboxSize]));
				bbox = bbox.concat(mercator.forward([longitude + config.app.bboxSize, latitude - config.app.bboxSize]));
				map.extent = bbox;

				var image = new mapnik.Image(config.app.imageSize.large, config.app.imageSize.large);
				map.render(image, function (err, img) {
					if (err) {
						console.error("Can not render image, because: " + err);
						callback(err);
						return;
					}
					callback(null, img);
				});
			},
			function (img, callback) {
				img.encode('png', function(err, buffer) {
					if (err) {
						console.error("Can not encode image, because: " + err);
						callback(err);
						return;
					}

					var tileFileName = config.app.tmpTilesDir + tileName + ".png";
					fs.writeFile(tileFileName, buffer, function (err) {
						if (err) {
							console.error("Can not save tile " + tileName + " , because: " + err);
							callback(err);
							return;
						}
						callback(null);
					});
				});
			}
	], function (err) {
		if (err) {
			console.error("Render tile occurred with error: " + err);
			done(err);
			return;
		}

		done(null);
	});
}

function mkdir(dir, callback) {
	mkdirp(dir, function (err, made) {
		if (err) {
			console.error("Can not mkdir for path ", dir, " err: ", err, " made: ", made);
			callback(new Error("Can not mkdir " + dir));
			return;
		}
		callback();
	});
}

function mkSizeDirs(done) {
    async.parallel([
		function (callback) { 
			mkdir(config.app.binDir.small, callback);
		},
		function (callback) {
			mkdir(config.app.binDir.medium, callback);
		},
		function (callback) {
			mkdir(config.app.binDir.large, callback);
		}
    ], function (err) {
		if (err) {
			console.error("Can not mkdir, because: " + err);
			done(err);
			return;
		}
		done();
    });
}

function convertAndResizeTiles (done) {
	fs.readdir(config.app.tmpTilesDir, function (err, files) {
		if (err) {
			console.error("Can not read dir " + config.app.tmpTilesDir + ", because: " + err);
			done(err);
			return;
		}

		console.log("Try process " + files.length + " tiles");
		var fileIndex = 0;

		async.eachLimit(files, config.app.renderLimit, function (file, fileDone) {
			async.parallel([
				function (callback) {
					convertAndResizeTile("small", file, callback);
				},
				function (callback) {
					convertAndResizeTile("medium", file, callback);
				},
				function (callback) {
					convertAndResizeTile("large", file, callback);
				},
			], function (err) {
				if (err) {
					console.error("Can not convert and resize tile " + file + ", because: " + err);
					fileDone(err);
					return;
				}

				prittyPrint(file, fileIndex, files.length, 50);
				fileIndex++;

				fileDone();
			});
		}, function (err) {
			if (err) {
				console.error("Can not process tiles in " + config.app.tmpTilesDir + ", because: " + err);
				done(err);
				return;
			}
			done();
		});
	});
}
	
function convertAndResizeTile (size, file, callback) {
    var inputTile = config.app.tmpTilesDir + file;
    var outputTile = config.app.binDir[size] + file.replace(".png", ".jpg");
    gm(inputTile).resize(config.app.imageSize[size]).quality(config.app.imageQuality).write(outputTile, function (err) {
		if (err) {
			console.error("Can not convert and resize tile " + inputTile + ", because: "  + err);
			callback(err);
			return;
		}
		callback();
    });
}

function main() {
	checkData();

	async.waterfall([
		mkTilesdir,
		mkSizeDirs,
		copyStyleFiles,
		generateCitiesJSON,
		loadStylesheetTemplate,
		renderTiles,
		convertAndResizeTiles
	], function (err) {
		if (err) {
			console.error("Error in main: " + err);
			return;
		}
		console.log("Hoooray!!! We did it! See bin folder.");
	});
}

main();

