
const express = require('express')
const { uuid } = require('uuidv4')

const fcl = require('@onflow/fcl')
const types = require('@onflow/types')
const cors = require('cors')

const { initializeApp } = require('firebase/app')
const { getFirestore, getDoc, setDoc, doc } = require('firebase/firestore/lite')

const firebaseConfig = {
  apiKey: "AIzaSyAS06GjOva_Mfq7A6uMNQxtW6aDmvBfubE",
  authDomain: "blocthon.firebaseapp.com",
  projectId: "blocthon",
  storageBucket: "blocthon.appspot.com",
  messagingSenderId: "81490186281",
  appId: "1:81490186281:web:6de883d4d67ea9a5a44c38",
  measurementId: "G-3811CHZTZN"
}

const app = express()
app.use(express.json())
app.use(cors())

const firebase = initializeApp(firebaseConfig)
const db = getFirestore(firebase)

fcl.config({ "accessNode.api": "https://rest-mainnet.onflow.org" })

const UNIT = 1000_000

const CONTAINER_TIERS = [
  { volume: 0, maxVolume: 10 * 3600 * UNIT, maxBobizs: 30 }
]

const FLOW_TIERS = [
  UNIT
]

const GROWTH_RATE = 3333

const makeBobiz = () => {
  const roll = Math.random();
  const variations = (() => {
    switch(true) {
      case roll > 0.99: return { capacity: 96 * 120 * UNIT, variant: 3 };
      case roll > 0.9: return { capacity: 48 * 120 * UNIT, variant: 2 };
      default: return { capacity: 24 * 120 * UNIT, variant: 1 };
    }
  })()
  return ({
    id: uuid(),
    absorbed: 0,
    ...variations
  })
}

const getStakedInfoScript = `
import FungibleToken from 0xf233dcee88fe0abe
import NonFungibleToken from 0x1d7e57aa55817448
import BloctoToken from 0x0f9df91c9121c460
import BloctoTokenStaking from 0x0f9df91c9121c460
import BloctoPass from 0x0f9df91c9121c460

pub struct BltStakeInfo {

  pub let isInit: Bool
  pub let isStakingEnabled: Bool
  pub let balance: UFix64?
  pub let tokensCommitted: UFix64?
  pub let tokensStaked: UFix64?
  pub let tokensRewarded: UFix64?
  pub let tokensUnstaked: UFix64?
  pub let tokensRequestedToUnstake: UFix64?
  pub let rewardPercentage: UFix64

  init(address: Address, index: Int) {
    let bltBalanceRef = getAccount(address)
      .getCapability(/public/bloctoTokenBalance)
      .borrow<&{FungibleToken.Balance}>()

    let vaultRef = getAccount(address)
      .getCapability(BloctoToken.TokenPublicReceiverPath)!
      .borrow<&BloctoToken.Vault{FungibleToken.Receiver}>()

    let collectionRef = getAccount(address)
      .getCapability(/public/bloctoPassCollection)
      .borrow<&{NonFungibleToken.CollectionPublic, BloctoPass.CollectionPublic}>()

    let stakerIds = collectionRef?.getIDs() ?? []

    self.isInit = vaultRef != nil && stakerIds.length != 0

    var stakerInfo: BloctoTokenStaking.StakerInfo? = nil
    if self.isInit {
      stakerInfo = BloctoTokenStaking.StakerInfo(stakerID: stakerIds[index])
    }

    self.isStakingEnabled = BloctoTokenStaking.getStakingEnabled()
    self.balance = bltBalanceRef?.balance
    self.tokensCommitted = stakerInfo?.tokensCommitted
    self.tokensStaked = stakerInfo?.tokensStaked
    self.tokensRewarded = stakerInfo?.tokensRewarded
    self.tokensUnstaked = stakerInfo?.tokensUnstaked
    self.tokensRequestedToUnstake = stakerInfo?.tokensRequestedToUnstake
    self.rewardPercentage = BloctoTokenStaking.getEpochTokenPayout() / BloctoTokenStaking.getTotalStaked()
  }
}

pub fun main(address: Address, index: Int): BltStakeInfo {                        
  return BltStakeInfo(address: address, index: index)
}
`

/*
const executeScript = async (script, args = []) =>
  fcl
    .send([fcl.getBlock(true)])
    .then(fcl.decode)
    .then(block => fcl.send([
      fcl.transaction(script),
      fcl.args(args),
      fcl.authorizations([authorization]),
      fcl.proposer(authorization),
      fcl.payer(authorization),
      fcl.ref(block.id),
      fcl.limit(100),
    ]))
    .then(({ transactionId }) => fcl.tx(transactionId).onceSealed())
    .catch(e => {
      console.error(e)
    })
*/

const updateGame = (user) => {
  const now = Date.now()
  const timeDiff = now - user.updatedAt
  let amount = user.flow * timeDiff / 1000
  user.bobizs.sort((a, b) => (a.capacity - a.absorbed) - (b.capacity - b.absorbed))
  const growthRequired = user.bobizs.map(bobiz => Math.min(bobiz.capacity - bobiz.absorbed, user.growthRate * timeDiff))
  const allRequired = growthRequired.reduce((acc, cur) => acc + cur, 0);
  const ratio = amount > allRequired ? 1 : (allRequired === 0 ? 0 : (amount / allRequired));

  growthRequired.forEach((required, i) => {
    const consumed = Math.floor(required * ratio);
    user.bobizs[i].absorbed += consumed;
    amount -= consumed;
  })
  user.container.volume = Math.min(user.container.maxVolume, user.container.volume + amount)
  
  user.updatedAt = now
  return user
}

// get user info
app.get('/users/:address', async function(req, res) {
  try {
    const userDoc = doc(db, "users", req.params.address);
    const ref = await getDoc(userDoc)
    const prev = ref.data()

    if (!prev) return res.send({ data: null })

    const data = updateGame(prev);
    await setDoc(userDoc, data)

    res.send({ data })
  } catch (error) {
    res.send({ error: error.message  })
  }
})

// create bobizs
app.post('/users/:address/bobizs', async function(req, res) {
  try {
    const userDoc = doc(db, "users", req.params.address);
    const ref = await getDoc(userDoc)

    const data = ref.data()

    const maximum = data.container.maxBobizs

    if(data.seeds <= 0) {
      throw new Error("E_NOT_ENOUGH_SEEDS")
    } else if (data.bobizs.length >= maximum) {
      throw new Error("E_LIMIT_EXCEED")
    }

    const newlyCreated = makeBobiz()
    data.bobizs.push(newlyCreated)
    data.seeds -= 1;

    const user = updateGame(data)

    await setDoc(userDoc, user)
    res.send({ data: newlyCreated });
  } catch(error) {
    res.send({ error: error.message })
  }
})

// harvest bobizs
app.post('/users/:address/bobizs/:id', async function(req, res) {
  try {
    const userDoc = doc(db, "users", req.params.address);
    const ref = await getDoc(userDoc)

    const data = ref.data()

    const index = data.bobizs.findIndex(d => d.id === req.params.id);
    if(index == -1) {
      throw new Error("E_ID_NOT_FOUND")
    }

    const found = data.bobizs[index];

    if (found.absorbed < found.capacity) {
      throw new Error("E_NOT_HARVESTABLE")
    }

    data.bobizCoin += 10

    data.bobizs.splice(index, 1)
    data.harvested[found.variant] += 1;
    const user = updateGame(data)
    // @todo: reward user with NFTs

    await setDoc(userDoc, user)
    res.send({ data: user });
  } catch(error) {
    res.send({ error: error.message })
  }
})

// buy seeds
app.post('/users/:address/seeds', async function(req, res) {
  try {
    const userDoc = doc(db, "users", req.params.address);
    const ref = await getDoc(userDoc)

    const amount = req.body.amount || 1

    const data = ref.data()

    const required = 5 * amount
    if(data.bobizCoin >= required) {
      data.bobizCoin -= required
      data.seeds += amount
    }
    const user = updateGame(data)
    await setDoc(userDoc, user)
    res.send({ data: user.seeds });
  } catch(error) {
    res.send({ error: error.message })
  }
})

// create new user record
app.post('/users/:address', async function(req, res) {
  try {
    // check stake status
    /*
    const response = await fcl
      .send([
        fcl.script(getStakedInfoScript),
        fcl.args([
          fcl.arg(req.params.address, types.Address),
          fcl.arg(0, types.Int),
        ]),
      ])
      .then(fcl.decode)

    const staked = +response.tokensCommitted + +response.tokenStaked
    
    if(staked < 1) {
      throw new Error("E_NOT_STAKED")
    }
    */

    // initialize user
    const instance = {
      container: CONTAINER_TIERS[0],
      flow: FLOW_TIERS[0],
      bobizs: [],
      bobizCoin: 0,
      seeds: 10,
      harvested: [0, 0, 0],
      growthRate: GROWTH_RATE,
      updatedAt: Date.now()
    }

    await setDoc(doc(db, "users", req.params.address), instance)
    res.send({ data: instance });
  } catch(error) {
    res.send({ error: error.message })
  }
})


app.get('/', function(req, res) {
  res.send('hello blocthon');
})


const port = 8787
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})

module.exports = app
