import { expect, use } from "chai";
import { deployContract, loadFixture, MockProvider, solidity } from "ethereum-waffle";
import StakePoolContract from "../artifacts/contracts/StakingPool.sol/StakingPool.json";
import { StakingPool } from "../ethers";
import { Wallet, utils, BigNumber } from "ethers";

use(solidity);

describe("Staking Pool", function () {
  const oneEWT = utils.parseUnits("1", "ether");

  const hardCap = oneEWT.mul(5000000);
  const contributionLimit = oneEWT.mul(50000);

  const ratio = 0.0000225;
  const ratioInt = utils.parseUnits(ratio.toString(), 18); // ratio as 18 digit number

  const timeTravel = async (provider: MockProvider, seconds: number) => {
    await provider.send("evm_increaseTime", [seconds]);
    await provider.send("evm_mine", []);
  };

  async function stakeAndTravel(stakingPool: StakingPool, value: BigNumber, seconds: number, provider: MockProvider) {
    await stakingPool.stake({ value });
    await timeTravel(provider, seconds);
  }

  async function fixture(
    hardCap: BigNumber,
    start: number,
    [owner, patron1, patron2]: Wallet[],
    provider: MockProvider,
    initializePool = true,
  ) {
    const duration = 3600 * 24 * 30;
    const end = start + duration;
    const rewards = oneEWT;

    const stakingPool = (await deployContract(owner, StakePoolContract)) as StakingPool;

    if (initializePool) {
      const asOwner = stakingPool.connect(owner);
      const tx = await asOwner.init(
        owner.address, //ToDo adapt with claimManager address
        start,
        end,
        ratioInt,
        hardCap,
        contributionLimit,
        {
          value: rewards,
        },
      );
      const { blockNumber } = await tx.wait();
      const { timestamp } = await provider.getBlock(blockNumber);

      await expect(tx).to.emit(stakingPool, "StakingPoolInitialized").withArgs(oneEWT, timestamp);
    }

    // travel to staking event start
    await timeTravel(provider, 10);

    return {
      stakingPool,
      patron1,
      patron2,
      owner,
      asPatron1: stakingPool.connect(patron1),
      asPatron2: stakingPool.connect(patron2),
      asOwner: stakingPool.connect(owner),
      provider,
      duration,
      start,
      end,
      hardCap,
      rewards,
    };
  }

  async function defaultFixture(wallets: Wallet[], provider: MockProvider) {
    const { timestamp } = await provider.getBlock("latest");
    const start = timestamp + 10;

    return fixture(hardCap, start, wallets, provider);
  }

  async function failureInitFixture(wallets: Wallet[], provider: MockProvider) {
    const { timestamp } = await provider.getBlock("latest");
    const start = timestamp + 10;

    return fixture(hardCap, start, wallets, provider, false);
  }

  async function initialStakeAndTravelToExpiryFixture(wallets: Wallet[], provider: MockProvider) {
    const { timestamp } = await provider.getBlock("latest");
    const start = timestamp + 10;

    const setup = await fixture(hardCap, start, wallets, provider);
    const { asPatron1, duration } = setup;

    await stakeAndTravel(asPatron1, oneEWT, duration, setup.provider);

    return setup;
  }

  it("Ownership can't be transferred to current owner", async function () {
    const { owner, asOwner } = await loadFixture(defaultFixture);
    await expect(asOwner.changeOwner(owner.address)).to.be.revertedWith("changeOwner: already owner");
  });

  it("Ownership can't be transferred by non owner", async function () {
    const { asPatron1, patron1 } = await loadFixture(defaultFixture);
    await expect(asPatron1.changeOwner(patron1.address)).to.be.revertedWith("OnlyOwner: Not authorized");
  });

  it("Ownership is correctly transferred", async function () {
    const { patron1, asOwner, stakingPool } = await loadFixture(defaultFixture);

    const tx = await asOwner.changeOwner(patron1.address);

    await expect(tx).to.emit(stakingPool, "OwnershipTransferred");
  });

  describe("Staking", async () => {
    it("should revert if staking pool is not initialized", async function () {
      const { asPatron1 } = await loadFixture(failureInitFixture);

      await expect(
        asPatron1.stake({
          value: oneEWT,
        }),
      ).to.be.revertedWith("Staking Pool not initialized");
    });

    it("can stake funds", async function () {
      const { stakingPool, patron1, asPatron1, provider } = await loadFixture(defaultFixture);

      const tx = await asPatron1.stake({
        value: oneEWT,
      });

      const { blockNumber } = await tx.wait();
      const { timestamp } = await provider.getBlock(blockNumber);

      await expect(tx).to.emit(stakingPool, "StakeAdded").withArgs(patron1.address, oneEWT, timestamp);

      const [deposit, compounded] = await asPatron1.total();

      expect(deposit).to.be.equal(compounded);
      expect(deposit).to.be.equal(oneEWT);
    });

    it("can stake funds multiple times", async function () {
      const { asPatron1 } = await loadFixture(defaultFixture);

      await asPatron1.stake({
        value: oneEWT,
      });

      await asPatron1.stake({
        value: oneEWT,
      });

      const [deposit, compounded] = await asPatron1.total();

      expect(deposit).to.be.equal(compounded);
      expect(deposit).to.be.equal(oneEWT.mul(2));
    });

    it("should increase the balance of the staking pool", async function () {
      const { stakingPool, asPatron1 } = await loadFixture(defaultFixture);

      await expect(
        await asPatron1.stake({
          value: oneEWT,
        }),
      ).to.changeEtherBalance(stakingPool, oneEWT);
    });

    it("should revert when staking pool reached the hard cap", async function () {
      const hardCap = utils.parseUnits("2", "ether");
      const { asPatron1, asPatron2 } = await loadFixture(async (wallets: Wallet[], provider: MockProvider) => {
        const { timestamp } = await provider.getBlock("latest");
        const start = timestamp + 10;
        return fixture(hardCap, start, wallets, provider);
      });

      await asPatron1.stake({
        value: oneEWT.mul(2),
      });

      await expect(
        asPatron2.stake({
          value: oneEWT,
        }),
      ).to.be.revertedWith("Staking pool is full");
    });

    it("should revert when stake is greater than contribution limit", async function () {
      const { asPatron1 } = await loadFixture(defaultFixture);

      const patronStake = utils.parseUnits("50001", "ether");

      await expect(
        asPatron1.stake({
          value: patronStake,
        }),
      ).to.be.revertedWith("Stake greater than contribution limit");
    });

    it("should revert when staking pool has not yet started", async function () {
      const { asPatron1 } = await loadFixture(async (wallets: Wallet[], provider: MockProvider) => {
        const { timestamp } = await provider.getBlock("latest");
        const start = timestamp + 100; //future
        return fixture(hardCap, start, wallets, provider);
      });

      await expect(
        asPatron1.stake({
          value: oneEWT,
        }),
      ).to.be.revertedWith("Staking pool not yet started");
    });

    it("should revert when staking pool already expired", async function () {
      const { asPatron1, duration, provider } = await loadFixture(defaultFixture);

      await timeTravel(provider, duration + 1);

      await expect(
        asPatron1.stake({
          value: oneEWT,
        }),
      ).to.be.revertedWith("Staking pool already expired");
    });

    it("should not compound stake after reaching expiry date", async function () {
      const { asPatron1, duration, provider } = await loadFixture(defaultFixture);

      await stakeAndTravel(asPatron1, oneEWT, duration + 1, provider);

      const [deposit, compounded] = await asPatron1.total();

      await timeTravel(provider, duration + 1);

      const [stakeAfterExpiry, compoundedAfterExpiry] = await asPatron1.total();

      expect(stakeAfterExpiry).to.be.equal(deposit);
      expect(compoundedAfterExpiry).to.be.equal(compounded);
    });
  });

  describe("Unstaking", async () => {
    it("can unstake funds", async function () {
      const { patron1, asPatron1 } = await loadFixture(defaultFixture);

      await asPatron1.stake({
        value: oneEWT,
      });

      await expect(await asPatron1.unstakeAll()).to.changeEtherBalance(patron1, oneEWT);

      const [deposit, compounded] = await asPatron1.total();

      expect(deposit).to.be.equal(BigNumber.from(0));
      expect(compounded).to.be.equal(BigNumber.from(0));
    });

    it("should decrease the balance of the staking pool", async function () {
      const { stakingPool, asPatron1 } = await loadFixture(defaultFixture);

      await asPatron1.stake({
        value: oneEWT,
      });

      await expect(await asPatron1.unstakeAll()).to.changeEtherBalance(stakingPool, oneEWT.mul(-1));
    });

    it("should revert when no funds staked before", async function () {
      const { asPatron1, asPatron2 } = await loadFixture(defaultFixture);

      await asPatron1.stake({
        value: oneEWT,
      });

      await expect(asPatron2.unstakeAll()).to.be.revertedWith("No funds available");
    });

    it("should allow partial withdrawal up to compounded value", async function () {
      const { asPatron1, provider, duration } = await loadFixture(defaultFixture);

      const initialStake = oneEWT;

      await stakeAndTravel(asPatron1, initialStake, duration / 2, provider);

      let [deposit, compounded] = await asPatron1.total();

      const initialCompounded = compounded;

      expect(compounded.gt(deposit)).to.be.true;

      const withdrawalValue = initialStake.div(2);

      await asPatron1.unstake(withdrawalValue);

      [deposit, compounded] = await asPatron1.total();

      expect(deposit).to.be.equal(initialStake.sub(withdrawalValue));
      expect(compounded).to.be.equal(initialCompounded.sub(withdrawalValue));

      await asPatron1.unstake(withdrawalValue);

      [deposit, compounded] = await asPatron1.total();

      expect(deposit).to.be.equal(BigNumber.from(0));
      expect(compounded.gt(0)).to.be.true;

      await asPatron1.unstake(compounded);

      [deposit, compounded] = await asPatron1.total();

      expect(deposit).to.be.equal(BigNumber.from(0));
      expect(compounded).to.be.equal(BigNumber.from(0));
    });
  });

  describe("Sweeping", async () => {
    async function quote(stakingPools: StakingPool[]) {
      let deposits = BigNumber.from(0);
      let rewards = BigNumber.from(0);

      for (const stakingPool of stakingPools) {
        const [deposit, compounded] = await stakingPool.total();
        const reward = compounded.sub(deposit);

        deposits = deposits.add(deposit);
        rewards = rewards.add(reward);
      }

      return { deposits, rewards };
    }

    async function calculateExpectedSweep(stakingPools: StakingPool[], initialRewards: BigNumber) {
      const { rewards } = await quote(stakingPools);

      return initialRewards.sub(rewards);
    }

    async function assertTransferAndBalance(
      initialRewards: BigNumber,
      patrons: StakingPool[],
      asOwner: StakingPool,
      owner: Wallet,
      provider: MockProvider,
      expectedSweep?: BigNumber,
      expectedBalance?: BigNumber,
    ) {
      const { deposits, rewards } = await quote(patrons);

      const toSweep = expectedSweep ?? (await calculateExpectedSweep(patrons, initialRewards));

      await expect(await asOwner.sweep()).to.changeEtherBalance(owner, toSweep);

      expect(await provider.getBalance(asOwner.address)).to.be.equal(expectedBalance ?? deposits.add(rewards));
    }

    it("should not allow to sweep before expiry", async function () {
      const { asOwner } = await loadFixture(defaultFixture);

      await expect(asOwner.sweep()).to.be.revertedWith("Cannot sweep before expiry");
    });

    it("should allow to sweep only once", async function () {
      const { asOwner } = await loadFixture(initialStakeAndTravelToExpiryFixture);

      await asOwner.sweep();

      await expect(asOwner.sweep()).to.be.revertedWith("Already sweeped");
    });

    it("should sweep remaining rewards when patron staked", async function () {
      const { owner, asPatron1, asOwner, provider, rewards } = await loadFixture(initialStakeAndTravelToExpiryFixture);

      await assertTransferAndBalance(rewards, [asPatron1], asOwner, owner, provider);
    });

    it("should sweep remaining rewards when patron staked multiple times", async function () {
      const { owner, asPatron1, asOwner, duration, provider, rewards } = await loadFixture(defaultFixture);

      await stakeAndTravel(asPatron1, oneEWT, duration / 2, provider);
      await stakeAndTravel(asPatron1, oneEWT, duration, provider);

      await assertTransferAndBalance(rewards, [asPatron1], asOwner, owner, provider);
    });

    it("should sweep remaining rewards when patron staked multiple times from multiple patrons", async function () {
      const { owner, asPatron1, asPatron2, asOwner, duration, provider, rewards } = await loadFixture(defaultFixture);

      await stakeAndTravel(asPatron1, oneEWT, duration / 2, provider);
      await stakeAndTravel(asPatron2, oneEWT, 0, provider);

      await stakeAndTravel(asPatron1, oneEWT, duration, provider);

      const expectedSweep = await calculateExpectedSweep([asPatron1, asPatron2], rewards);
      await assertTransferAndBalance(rewards, [asPatron1, asPatron2], asOwner, owner, provider, expectedSweep);
    });

    it("should sweep remaining rewards when patron staked and withdrawn after expiry", async function () {
      const { owner, asPatron1, asOwner, provider, rewards } = await loadFixture(initialStakeAndTravelToExpiryFixture);

      const expectedSweep = await calculateExpectedSweep([asPatron1], rewards);

      await asPatron1.unstakeAll();

      await assertTransferAndBalance(rewards, [asPatron1], asOwner, owner, provider, expectedSweep, BigNumber.from(0));
    });

    it("should sweep remaining rewards when patron staked and withdrawn before expiry", async function () {
      const { owner, asPatron1, asOwner, duration, provider, rewards } = await loadFixture(defaultFixture);

      await stakeAndTravel(asPatron1, oneEWT, duration / 2, provider);

      await asPatron1.unstake(oneEWT);

      await timeTravel(provider, duration);

      await assertTransferAndBalance(rewards, [asPatron1], asOwner, owner, provider);
    });
  });

  it("maximum compound precision error should not result in error greater than 1 cent", async function () {
    const { stakingPool, start, end, duration } = await loadFixture(defaultFixture);

    const oneCent = utils.parseUnits("0.001", "ether");

    const patronStake = 50000;
    const patronStakeWei = utils.parseUnits(patronStake.toString(), "ether");

    const periods = duration / 3600;

    const compounded = await stakingPool.compound(patronStakeWei, start, end);

    const expectedCompounded = patronStake * Math.pow(1 + ratio, periods);
    const expected = utils.parseUnits(expectedCompounded.toString(), 18);
    const diff = compounded.sub(expected).abs().toNumber();

    expect(diff).to.be.lessThanOrEqual(oneCent.toNumber());
  });
});
