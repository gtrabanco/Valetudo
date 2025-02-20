const express = require("express");
const nestedProperty = require("nested-property");
const RateLimit = require("express-rate-limit");

const Logger = require("../Logger");
const Tools = require("../Tools");
const {SSEHub, SSEMiddleware} = require("./middlewares/sse");

class ValetudoRouter {
    /**
     *
     * @param {object} options
     * @param {import("../Configuration")} options.config
     * @param {import("../core/ValetudoRobot")} options.robot
     * @param {*} options.validator
     */
    constructor(options) {
        this.router = express.Router({mergeParams: true});

        this.config = options.config;
        this.robot = options.robot;
        this.validator = options.validator;

        //@ts-ignore
        // noinspection PointlessArithmeticExpressionJS
        this.limiter = new RateLimit({
            windowMs: 1*30*1000,
            max: 30
        });

        this.initRoutes();
        this.initSSE();
    }


    initRoutes() {
        this.router.get("/", (req, res) => {
            res.json({
                embedded: this.config.get("embedded")
            });
        });

        this.router.get("/version", (req, res) => {
            res.json({
                release: Tools.GET_VALETUDO_VERSION(),
                commit: Tools.GET_COMMIT_ID()
            });
        });

        this.router.get("/log/content", this.limiter, (req, res) => {
            res.sendFile(Logger.getLogFilePath());
        });


        const LogLevels = Object.keys(Logger.getProperties().LogLevels);
        this.router.get("/log/level", (req, res) => {
            res.json({
                current: Logger.getLogLevel(),
                presets: LogLevels
            });
        });

        this.router.put("/log/level", this.validator, (req, res) => {
            if (req.body && req.body.level && typeof req.body.level === "string") {
                Logger.setLogLevel(req.body.level);

                res.sendStatus(202);
            } else {
                res.sendStatus(400);
            }

        });

        this.router.get("/config/interfaces/mqtt", (req, res) => {
            let mqttConfig = Tools.CLONE(this.config.get("mqtt"));

            MQTT_CONFIG_PRIVATE_PATHS.forEach(path => {
                if (nestedProperty.get(mqttConfig, path)) {
                    nestedProperty.set(mqttConfig, path, MAGIC_PRIVACY_STRING);
                }
            });

            res.json(mqttConfig);
        });

        this.router.get("/config/interfaces/mqtt/properties", (req, res) => {
            //It might make sense to pull this from the mqttController but that would introduce a dependency between the webserver and the mqttController :/
            res.json({
                defaults: {
                    identity: {
                        friendlyName: this.robot.getModelName() + " " + Tools.GET_HUMAN_READABLE_SYSTEM_ID(),
                        identifier: Tools.GET_HUMAN_READABLE_SYSTEM_ID()
                    },
                    customizations: {
                        topicPrefix: "valetudo"
                    }
                }
            });
        });

        this.router.put("/config/interfaces/mqtt", this.validator, (req, res) => {
            let mqttConfig = req.body;
            let oldConfig = this.config.get("mqtt");


            MQTT_CONFIG_PRIVATE_PATHS.forEach(path => {
                if (nestedProperty.get(mqttConfig, path) === MAGIC_PRIVACY_STRING) {
                    nestedProperty.set(mqttConfig, path, nestedProperty.get(oldConfig, path));
                }
            });

            this.config.set("mqtt", mqttConfig);

            res.sendStatus(202);
        });

        this.router.get("/config/interfaces/http/auth/basic", (req, res) => {
            res.json({...this.config.get("webserver").basicAuth, password: ""});
        });

        this.router.put("/config/interfaces/http/auth/basic", this.validator, (req, res) => {
            if (
                req.body && typeof req.body === "object" &&
                typeof req.body.enabled === "boolean" &&
                typeof req.body.username === "string" &&
                typeof req.body.password === "string"
            ) {
                const webserverConfig = this.config.get("webserver");

                const options = {
                    enabled: req.body.enabled,
                    username: req.body.username,
                    password: req.body.password
                };


                if (!options.password && (webserverConfig.basicAuth.enabled === false && options.enabled === true)) {
                    res.status(400).send("Missing password for basic auth enable. Don't lock yourself out!");
                } else {
                    webserverConfig.basicAuth = options;

                    this.config.set("webserver", webserverConfig);
                    res.sendStatus(201);
                }
            } else {
                res.status(400).send("bad request body");
            }

        });
    }

    initSSE() {
        this.sseHubs = {
            log: new SSEHub({name: "Log"}),
        };
        const LogMessageEventType = Logger.getProperties().EVENTS.LogMessage;

        Logger.onLogMessage((line) => {
            /**
             * To be parsed correctly, one line needs to be one sse event.
             *
             * While the sseHub could handle this, it only is an issue when sending logs.
             * Everything else using SSE in valetudo is a single-line string
             *
             * To not waste CPU cycles for nothing, we therefore do the splitting here
             */
            line.split("\n").forEach(actualLine => {
                this.sseHubs.log.event(
                    LogMessageEventType,
                    actualLine
                );
            });
        });

        this.router.get(
            "/log/content/sse",
            SSEMiddleware({
                hub: this.sseHubs.log,
                keepAliveInterval: 5000,
                maxClients: 5
            }),
            (req, res) => {
                //Intentional, as the response will be handled by the SSEMiddleware
            }
        );
    }

    getRouter() {
        return this.router;
    }

    shutdown() {
        Object.values(this.sseHubs).forEach(hub => {
            hub.shutdown();
        });
    }
}

const MAGIC_PRIVACY_STRING = "<redacted>";
const MQTT_CONFIG_PRIVATE_PATHS = [
    "connection.authentication.credentials.username",
    "connection.authentication.credentials.password",
    "connection.authentication.clientCertificate.certificate",
    "connection.authentication.clientCertificate.key"
];

module.exports = ValetudoRouter;
