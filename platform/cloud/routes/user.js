// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2015 Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details

const Q = require('q');
const express = require('express');
const passport = require('passport');

const user = require('../util/user');
const model = require('../model/user');
const db = require('../util/db');

var TITLE = "ThingEngine";

const EngineManager = require('../enginemanager');

var router = express.Router();

router.get('/oauth2/google', passport.authenticate('google', {
    scope: (['openid','profile','email',
             'https://www.googleapis.com/auth/fitness.activity.read',
             'https://www.googleapis.com/auth/fitness.location.read',
             'https://www.googleapis.com/auth/fitness.body.read']
            .join(' '))
}));
router.get('/oauth2/google/callback', passport.authenticate('google'),
           function(req, res, next) {
               // Redirection back to the original page
               var redirect_to = req.session.redirect_to ? req.session.redirect_to : '/';
               delete req.session.redirect_to;
               res.redirect(redirect_to);
           });

router.get('/oauth2/facebook', passport.authenticate('facebook', {
    scope: 'public_profile email'
}));
router.get('/oauth2/facebook/callback', passport.authenticate('facebook'),
           function(req, res, next) {
               // Redirection back to the original page
               var redirect_to = req.session.redirect_to ? req.session.redirect_to : '/';
               delete req.session.redirect_to;
               res.redirect(redirect_to);
           });


router.get('/login', function(req, res, next) {
    req.logout();
    res.render('login', {
        csrfToken: req.csrfToken(),
        errors: req.flash('error'),
        page_title: "ThingEngine - Login"
    });
});


router.post('/login', passport.authenticate('local', { failureRedirect: '/user/login',
                                                       failureFlash: true }),
            function(req, res, next) {
                // Redirection back to the original page
                var redirect_to = req.session.redirect_to ? req.session.redirect_to : '/';
                delete req.session.redirect_to;
                res.redirect(redirect_to);
            });


router.get('/register', function(req, res, next) {
    res.render('register', {
        csrfToken: req.csrfToken(),
        page_title: "ThingEngine - Register"
    });
});


router.post('/register', function(req, res, next) {
    var username, password, email;
    try {
        if (typeof req.body['username'] !== 'string' ||
            req.body['username'].length == 0 ||
            req.body['username'].length > 255)
            throw new Error("You must specify a valid username");
        username = req.body['username'];
        if (typeof req.body['email'] !== 'string' ||
            req.body['email'].length == 0 ||
            req.body['email'].indexOf('@') < 0 ||
            req.body['email'].length > 255)
            throw new Error("You must specify a valid email");
        email = req.body['email'];

        if (typeof req.body['password'] !== 'string' ||
            req.body['password'].length < 8 ||
            req.body['password'].length > 255)
            throw new Error("You must specifiy a valid password (of at least 8 characters)");

        if (req.body['confirm-password'] !== req.body['password'])
            throw new Error("The password and the confirmation do not match");
            password = req.body['password']

    } catch(e) {
        res.render('register', {
            csrfToken: req.csrfToken(),
            page_title: "ThingEngine - Register",
            error: e.message
        });
        return;
    }

    return db.withTransaction(function(dbClient) {
        return user.register(dbClient, username, password, email).then(function(user) {
            return EngineManager.get().startUser(user).then(function() {
                return Q.ninvoke(req, 'login', user);
            }).then(function() {
                res.locals.authenticated = true;
                res.locals.user = user;
                res.render('register_success', {
                    page_title: "ThingEngine - Registration Successful",
                    username: username,
                    cloudId: user.cloud_id,
                    authToken: user.auth_token });
            });
        });
    }).catch(function(error) {
        res.render('register', {
            csrfToken: req.csrfToken(),
            page_title: "ThingEngine - Register",
            error: error.message });
    }).done();
});


router.get('/logout', function(req, res, next) {
    req.logout();
    res.redirect('/');
});

function getProfile(req, res, error) {
    return EngineManager.get().getEngine(req.user.id).then(function(engine) {
        return Q.all([engine.devices.getDevice('thingengine-own-server'),
                      engine.devices.getDevice('thingengine-own-phone')]);
    }).spread(function(server, phone) {
        return Q.all([server ? server.state : undefined, phone ? phone.state : undefined]);
    }).spread(function(serverState, phoneState) {
        var server, phone;
        if (serverState) {
            server = {
                isConfigured: true,
                name: serverState.host,
                port: serverState.port
            };
        } else {
            server = {
                isConfigured: false
            };
        }
        if (phoneState) {
            phone = {
                isConfigured: true,
            };
        } else {
            phone = {
                isConfigured: false,
                qrcodeTarget: 'https://thingengine.stanford.edu/qrcode-cloud/' + req.user.cloud_id + '/'
                    + req.user.auth_token
            }
        }

        res.render('user_profile', { page_title: "ThingEngine - User Profile",
                                     csrfToken: req.csrfToken(),
                                     error: error,
                                     server: server,
                                     phone: phone });
    }).catch(function(e) {
        res.status(400).render('error', { page_title: "ThingEngine - Error",
                                          message: e.message });
    });
}

router.get('/profile', user.redirectLogIn, function(req, res, next) {
    getProfile(req, res, undefined).done();
});

router.post('/profile', user.requireLogIn, function(req, res, next) {
    return db.withTransaction(function(dbClient) {
        var developerKey = req.body.developer_key;
        if (!developerKey || developerKey.length < 64)
            developerKey = null;

        return model.update(dbClient, req.user.id,
                            { human_name: req.body.human_name,
                              developer_key: developerKey
                              });
    }).then(function() {
        var restartEngine = false;
        if (req.user.developer_key !== req.body.developer_key)
            restartEngine = true;

        req.user.human_name = req.body.human_name;
        req.user.developer_key = req.body.developer_key;

        if (restartEngine) {
            EngineManager.get().killUser(req.user.id);
            return EngineManager.get().startUser(req.user);
        }
    }).then(function() {
        return getProfile(req, res, undefined);
    }).done();
});

router.post('/change-password', user.requireLogIn, function(req, res, next) {
    var username, password, oldpassword;
    Q.try(function() {
        if (typeof req.body['password'] !== 'string' ||
            req.body['password'].length < 8 ||
            req.body['password'].length > 255)
            throw new Error("You must specifiy a valid password (of at least 8 characters)");

        if (req.body['confirm-password'] !== req.body['password'])
            throw new Error("The password and the confirmation do not match");
        password = req.body['password'];

        if (req.user.password) {
            if (typeof req.body['old_password'] !== 'string')
                throw new Error("You must specifiy your old password");
            oldpassword = req.body['old_password'];
        }

        return db.withTransaction(function(dbClient) {
            return user.update(dbClient, req.user, oldpassword, password);
        }).then(function() {
            res.redirect('/user/profile');
        });
    }).catch(function(e) {
        return getProfile(req, res, e.message);
    }).done();
});

router.post('/delete', user.requireLogIn, function(req, res, next) {
    db.withTransaction(function(dbClient) {
        return EngineManager.get().deleteUser(req.user.id).then(function() {
            return model.delete(dbClient, req.user.id);
        });
    }).then(function() {
        req.logout();
        res.redirect('/');
    }).done();
});

module.exports = router;
