var log = require("./logger");
var kue = require('kue');
var WebSocket = require('ws');
var ws = new WebSocket('wss://ws.chain.com/v2/notifications');
var models = require("../models");
var queue = require('./queue.js');


module.exports.trans = function () {

  queue.process('transactionHash', 500, function (job, done) {

    // create a object for blockchain transaction subs
    console.log("Processing Job : " + job.id);
    var btcAddress = job.data.btcAddress;
    // create a object for blockchain address subs
    var reqWs = {
      type: "address",
      address: btcAddress,
      block_chain: "bitcoin"
    };
    // log BTC address
    log.debug("BTC Address is : " + btcAddress);
    // subscribe to block chain address notifications
    ws.send(JSON.stringify(reqWs));
    ws.on('message', function (ev) {
      // log block chain notification
      var x = (JSON.parse(ev));
      if (x.payload.type === "address") {
        if (x.payload.address === btcAddress) {
          var hash = x.payload.transaction_hash;
          // log transaction hash
          log.debug("Transaction hash : " + x.payload.transaction_hash);
          // update in database
          models.Invoice.find({ where: { btcAddress: btcAddress } }).then(function (found) {
            if (found) {
              // update if found
              found.updateAttributes({ transactionId: hash });
              // create confirmation job in kue
              var job = queue.create('confirmation', {
                transHash: hash,
                btcAddress: btcAddress
              }).priority('high').save(function (err) {
                if (err) log.error("Kue job error : " + err);
                else {
                  log.debug("Job id : " + job.id);
                  done();
                }
              });
            }
          });
        }
      } else {
        {
          // log heartbeat
          log.debug(x.payload);
        }
      }
    });
  });

  queue.process('confirmation', function (job, done) {
    // create a object for blockchain transaction subs
    var hash = job.data.transHash;
    var btcAddress = job.data.btcAddress;
    var reqInv = {
      type: "transaction",
      transaction_hash: hash,
      block_chain: "bitcoin"
    };
    // subscribe to block chain transaction notifications
    ws.send(JSON.stringify(reqInv));
    var receivedConf = 0, invoiceConf = 0, requiredConf = 0;
    ws.on('message', function (ev) {

      var y = (JSON.parse(ev));
      if (y.payload.type === "transaction") {
        // log received confirmations
        console.log(y.payload.transaction.inputs[0].addresses);

        log.debug("Confirmation received : " + y.payload.transaction.confirmations);
        receivedConf = y.payload.transaction.confirmations;
        // find invoice previous and required confirmations

        models.Invoice.find({ where: { btcAddress: btcAddress } }).then(function (found) {
          if (found) {
            // if the record exists in the db
            log.debug("Invoice pervious conf : " + found.confirmations);
            invoiceConf = found.confirmations;
            requiredConf = found.confirmationSpeed;

            log.debug("Current inv conf : " + invoiceConf);
            log.debug("Required inv conf : " + requiredConf);

            if (receivedConf > invoiceConf) {

              if (receivedConf === requiredConf) { 
                // update invoice status
                found.updateAttributes({ status: "paid", confirmations: receivedConf }).then(function () {

                  // *** from invoice to user *** //    
                  
                  var ledger;
                  ledger.from = "invoice";
                  ledger.to = found.userId; // user id
                  ledger.refId = found.Id; // invoice id
                  ledger.currency = "BTC";
                  ledger.amount = found.amount;
                  ledger.rate = found.rate;
                  
                  // add to ledgers
                  models.Ledgers.create(ledger).then(function (ledger) {
                    log.debug("Created ledger: " + ledger.id);
                  }).catch(function (error) {
                    console.log("ops: " + error);
                  });
                  
                  // *** from user to exchange *** // 
                   
                  ledger.from = found.userId; // user id
                  ledger.to = "exchange"; // user id
                                  
                  // add to ledgers
                  models.Ledgers.create(ledger).then(function (ledger) {
                    log.debug("Created ledger: " + ledger.id);
                  }).catch(function (error) {
                    console.log("ops: " + error);
                  });
                  
                  // *** from exchange to user *** // 
                   
                  ledger.from = "exchange";
                  ledger.to = found.userId; // user id
                  ledger.currency = "PKR";

                  // add to ledgers
                  models.Ledgers.create(ledger).then(function (ledger) {
                    log.debug("Created ledger: " + ledger.id);
                  }).catch(function (error) {
                    console.log("ops: " + error);
                  });

                  done();
                });
              }
              else {
                // update invoice confirmations
                found.updateAttributes({ confirmations: receivedConf });
              }
            }
          }
        }).catch(function (error) {
          log.debug("Error : " + error);
        });
      }
    });
  });
};
