/* Wallet console helpers. No product-level KYT switch or hardcoded Gateway addresses. */
(function (root) {
  "use strict";
  function createClient({ ethers, abis, provider, signer, chainId, contractAt }) {
    const addr = ethers.getAddress;
    const zero = ethers.ZeroAddress;
    const contract = contractAt || ((name, address) => new ethers.Contract(address, abis[name], signer));
    const tokenAt = address => new ethers.Contract(address, [
      "function allowance(address,address) view returns(uint256)",
      "function approve(address,uint256) returns(bool)",
    ], signer);
    const same = (a, b) => addr(a) === addr(b);
    async function network() {
      if (chainId == null || BigInt(chainId) !== (await provider.getNetwork()).chainId) {
        throw new Error("Wallet network does not match the deployment configuration");
      }
    }
    async function context(vaultAddress) {
      await network();
      const vault = addr(vaultAddress), v = contract("EarnVault", vault);
      const [gate, asset, owner, manager, timelock] = await Promise.all([
        v.gate(), v.usdt(), v.owner(), v.stateManager(), v.vaultTimelock(),
      ]);
      const product = Number(await contract("StateManager", manager).getProductState(vault));
      return { vault, gate: addr(gate), asset: addr(asset), owner: addr(owner), timelock: addr(timelock), product };
    }
    async function gatewayInfo(vaultAddress, gatewayAddress) {
      await network();
      const gateway = addr(gatewayAddress);
      if (gateway === zero) throw new Error("Gateway address is zero");
      const g = contract("KYTDepositGateway", gateway);
      const [vault, asset, admin, oracle, validityPeriod, expectedAsset] = await Promise.all([
        g.vault(), g.asset(), g.admin(), g.oracle(), g.validityPeriod(), contract("EarnVault", vaultAddress).usdt(),
      ]);
      if (!same(vault, vaultAddress) || !same(asset, expectedAsset)) throw new Error("Gateway vault/asset binding mismatch");
      if (addr(oracle) === zero || BigInt(validityPeriod) < 300n || BigInt(validityPeriod) > 604800n) {
        throw new Error("Unsupported Gateway configuration");
      }
      return { gateway, vault: addr(vault), asset: addr(asset), admin: addr(admin), oracle: addr(oracle), validityPeriod };
    }
    async function route(vaultAddress) {
      await network();
      const v = contract("EarnVault", vaultAddress);
      const [gate, asset] = await Promise.all([v.gate(), v.usdt()]);
      if (addr(asset) === zero) throw new Error("Vault asset is not configured");
      if (addr(gate) === zero) return { mode: "direct", vault: addr(vaultAddress), asset: addr(asset), gateway: null };
      const info = await gatewayInfo(vaultAddress, gate);
      return { mode: "kyt", vault: addr(vaultAddress), asset: info.asset, gateway: info.gateway };
    }
    function events(name, address, receipt, eventName) {
      const iface = contract(name, address).interface;
      return receipt.logs.flatMap(log => {
        if (!same(log.address, address)) return [];
        try { const p = iface.parseLog(log); return p?.name === eventName ? [p.args] : []; }
        catch { return []; }
      });
    }
    function onlyEvent(name, address, receipt, eventName) {
      const rows = events(name, address, receipt, eventName);
      if (rows.length !== 1) throw Object.assign(new Error("Receipt unresolved; inspect the transaction before retrying"),
        { txHash: receipt.hash, code: "RECEIPT_UNRESOLVED" });
      return rows[0];
    }
    async function timelock(vaultAddress) {
      const ctx = await context(vaultAddress);
      if (ctx.timelock === zero) throw new Error("Vault Timelock is not configured");
      const tl = contract("VaultTimelock", ctx.timelock);
      if (!same(await tl.vault(), ctx.vault)) throw new Error("Timelock belongs to a different Vault");
      return { ctx, tl };
    }
    function gateValue(vaultAddress, change) {
      if (!same(change.target, vaultAddress)) throw new Error("Change targets a different Vault");
      const parsed = contract("EarnVault", vaultAddress).interface.parseTransaction({ data: change.data });
      if (parsed?.name !== "setGate") throw new Error("This is not a setGate change");
      return addr(parsed.args[0]);
    }
    async function getChange(vaultAddress, id) {
      const { ctx, tl } = await timelock(vaultAddress);
      const change = await tl.pendingChanges(id);
      const gate = gateValue(ctx.vault, change);
      const block = await provider.getBlock("latest");
      if (!block) throw new Error("Latest block unavailable");
      const now = BigInt(block.timestamp);
      const status = change.cancelled ? "cancelled" : change.executed ? "executed"
        : now > change.expiresAt ? "expired" : now < change.executableAfter ? "waiting" : "ready";
      return { id, gate, target: change.target, proposer: change.proposer, executableAfter: change.executableAfter,
        expiresAt: change.expiresAt, status };
    }
    async function listChanges(vaultAddress) {
      const { ctx, tl } = await timelock(vaultAddress);
      const count = BigInt(await tl.pendingChangeCount());
      const rows = [];
      for (let offset = 0n; offset < count; offset += 50n) {
        const ids = await tl.pendingChangesPaged(offset, 50n);
        for (const id of ids) {
          const change = await tl.pendingChanges(id);
          try { gateValue(ctx.vault, change); } catch { continue; } // Other parameter changes have their own console.
          rows.push(await getChange(ctx.vault, id));
        }
      }
      return rows;
    }
    async function changeGate(vaultAddress, nextGate) {
      const ctx = await context(vaultAddress), gate = addr(nextGate);
      if (!same(await signer.getAddress(), ctx.owner)) throw new Error("Only this Vault's Owner may configure its Gate");
      if (gate !== zero) await gatewayInfo(ctx.vault, gate);
      await network();
      const v = contract("EarnVault", ctx.vault);
      if (ctx.product === 0) {
        const receipt = await (await v.setGate(gate)).wait();
        return { kind: "direct", receipt, gate: addr(await v.gate()) };
      }
      const { tl } = await timelock(ctx.vault);
      const data = v.interface.encodeFunctionData("setGate", [gate]);
      const receipt = await (await tl.scheduleParamChange(ctx.vault, data)).wait();
      const e = onlyEvent("VaultTimelock", ctx.timelock, receipt, "ParamChangeScheduled");
      return { kind: "scheduled", receipt, change: await getChange(ctx.vault, e.changeId) };
    }
    async function executeChange(vaultAddress, id) {
      const change = await getChange(vaultAddress, id);
      if (change.status !== "ready") throw new Error(`Gate change is ${change.status}`);
      if (change.gate !== zero) await gatewayInfo(vaultAddress, change.gate);
      const { tl } = await timelock(vaultAddress);
      const receipt = await (await tl.executeParamChange(id)).wait();
      return { receipt, gate: addr(await contract("EarnVault", vaultAddress).gate()) };
    }
    async function cancelChange(vaultAddress, id) {
      await getChange(vaultAddress, id);
      const { tl } = await timelock(vaultAddress);
      return (await tl.cancelParamChange(id)).wait(); // Vault Owner / Guardian / original proposer, enforced on chain.
    }
    async function administer(vaultAddress, gatewayAddress, method, value) {
      if (!["setOracle", "setValidityPeriod", "transferAdmin"].includes(method)) throw new Error("Unsupported Gateway action");
      const info = await gatewayInfo(vaultAddress, gatewayAddress);
      if (!same(info.admin, await signer.getAddress())) throw new Error("Only the Gateway admin may perform this action");
      if (method === "setValidityPeriod") {
        value = BigInt(value);
        if (value < 300n || value > 604800n) throw new Error("Validity must be 300 to 604800 seconds");
      } else {
        value = addr(value);
        if (value === zero) throw new Error("Address cannot be zero");
      }
      await network();
      return (await contract("KYTDepositGateway", info.gateway)[method](value)).wait();
    }
    async function getRequest(vaultAddress, gatewayAddress, id) {
      await gatewayInfo(vaultAddress, gatewayAddress);
      const r = await contract("KYTDepositGateway", gatewayAddress).getRequest(BigInt(id));
      const names = ["NONE", "PENDING", "EXECUTED", "REJECTED", "CANCELLED"];
      let status = names[Number(r.state)];
      if (!status) throw new Error("Unknown KYT request state");
      const block = await provider.getBlock("latest");
      if (!block) throw new Error("Latest block unavailable");
      if (status === "PENDING" && BigInt(block.timestamp) > r.expiresAt) status = "EXPIRED (on-chain state: PENDING)";
      return { id: BigInt(id), payer: r.payer, owner: r.owner, assets: r.assets,
        requestedAt: r.requestedAt, expiresAt: r.expiresAt, status };
    }
    async function deposit(vaultAddress, assets, owner, onPhase = () => {}) {
      assets = BigInt(assets); owner = addr(owner);
      if (assets <= 0n || owner === zero) throw new Error("Invalid deposit amount/owner");
      const r = await route(vaultAddress), payer = addr(await signer.getAddress());
      const spender = r.gateway || r.vault, v = contract("EarnVault", r.vault);
      const operator = r.gateway || payer;
      const needsOperator = !same(owner, operator) && !(await v.isOperator(owner, operator));
      if (needsOperator && !same(owner, payer)) throw new Error("The beneficiary must first approve the required Vault operator");
      const token = contractAt ? contractAt("ERC20", r.asset) : tokenAt(r.asset);
      if (BigInt(await token.allowance(payer, spender)) < assets) {
        onPhase("Confirm token allowance in your wallet"); await network();
        await (await token.approve(spender, assets)).wait();
      }
      if (needsOperator) {
        onPhase("Confirm Gateway operator permission in your wallet"); await network();
        await (await v.setOperator(operator, true)).wait();
      }
      const fresh = await route(vaultAddress);
      if (fresh.gateway !== r.gateway || fresh.asset !== r.asset) throw new Error("Vault Gate changed; refresh before submitting");
      onPhase(r.gateway ? "Submit screening request (no funds moved yet)" : "Submit Vault deposit");
      const target = r.gateway ? contract("KYTDepositGateway", r.gateway) : v;
      const receipt = await (await target.requestDeposit(assets, owner)).wait();
      const e = onlyEvent(r.gateway ? "KYTDepositGateway" : "EarnVault", spender, receipt,
        r.gateway ? "ScreeningRequested" : "DepositRequested");
      return r.gateway ? { mode: "kyt", gateway: r.gateway, screeningRequestId: e.id, receipt }
        : { mode: "direct", vaultRequestId: e.requestId, receipt };
    }
    return { context, gatewayInfo, route, getChange, listChanges, changeGate, executeChange, cancelChange, administer, getRequest, deposit };
  }
  root.HT_KYT = { createClient };
})(typeof window !== "undefined" ? window : globalThis);
