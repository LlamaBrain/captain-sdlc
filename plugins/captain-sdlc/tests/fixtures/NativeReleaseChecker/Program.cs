using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

var argsList = args.ToList();
string Arg(string name) => argsList[argsList.IndexOf(name) + 1];
if (!argsList.Contains("--captain-context-stdin") || Arg("--project-root") != Directory.GetCurrentDirectory()) return 5;
if (Environment.GetEnvironmentVariables().Keys.Cast<string>().Any(name =>
    name is "CAPTAIN_SEQUENCE_AUTH_KEY" or "NODE_OPTIONS" or "NODE_PATH" or "GH_TOKEN" or "GITHUB_TOKEN"
    || name.StartsWith("DOTNET_STARTUP_HOOKS", StringComparison.OrdinalIgnoreCase)
    || name.StartsWith("CORECLR_PROFILER", StringComparison.OrdinalIgnoreCase))) return 6;
var store = Arg("--authority-store"); Directory.CreateDirectory(store);
var input = JsonNode.Parse(await Console.In.ReadToEndAsync())!.AsObject();
var key = Convert.FromBase64String(input["authority_key"]!.GetValue<string>());
if (key.Length != 32) return 7;
var optionsPath = Path.Combine(store, "fixture-options.json");
var options = File.Exists(optionsPath) ? JsonNode.Parse(File.ReadAllText(optionsPath))!.AsObject() : new JsonObject();
var mode = options["mode"]?.GetValue<string>() ?? "ready";
var report = new JsonObject { ["baseline_revision"] = input["base"]!.DeepClone(), ["target_revision"] = input["head"]!.DeepClone(), ["bump_kind"] = mode == "major" ? "major" : "none" };
var bytes = Encoding.UTF8.GetBytes(report.ToJsonString());
var digest = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
var reportPath = Path.Combine(store, digest + ".json"); File.WriteAllBytes(reportPath, bytes);
File.WriteAllText(Path.Combine(store, "authority-proof.txt"), Convert.ToHexString(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(input["base"]!.GetValue<string>()))));
var decisionPath = Path.Combine(store, "decision.json");
if (input["decision"] is JsonObject decision) {
    if (decision["report_digest"]!.GetValue<string>() != digest || decision["finding_digest"]!.GetValue<string>() != digest) return 8;
    if (!File.Exists(decisionPath)) File.WriteAllText(decisionPath, decision.ToJsonString());
}
var decided = File.Exists(decisionPath) ? JsonNode.Parse(File.ReadAllText(decisionPath))!.AsObject() : null;
var status = mode == "blocked" ? "blocked" : mode == "major" ? decided?["choice"]?.GetValue<string>() == "revise" ? "needs_revision" : decided is null ? "needs_human" : "ready" : "ready";
var humanPath = mode == "major" ? Path.Combine(store, digest + ".report.md") : null;
if (humanPath is not null) File.WriteAllText(humanPath, "# Fixture compatibility report\nSupported fixture contract changed; migrate to its replacement.\n" + input["base"] + "\n" + input["head"]);
var result = new JsonObject {
    ["Status"] = status, ["Bump"] = mode == "major" ? "major" : "none",
    ["Base"] = input["base"]!.DeepClone(), ["Head"] = input["head"]!.DeepClone(), ["Tree"] = input["tree"]!.DeepClone(),
    ["ReportDigest"] = digest, ["FindingDigest"] = digest, ["ReportPath"] = reportPath, ["HumanReportPath"] = humanPath,
    ["Errors"] = status == "ready" ? new JsonArray() : new JsonArray("compatibility decision required"),
    ["Coverage"] = new JsonArray(new JsonObject { ["Name"] = "native_api", ["Status"] = "unavailable", ["Reason"] = "Fixture has no native contract analyzer.", ["Affected"] = false, ["OnUnavailable"] = "report" })
};
if (mode == "blocked") { result["Coverage"] = null; result["ReportDigest"] = null; result["ReportPath"] = null; result["FindingDigest"] = null; }
if (mode == "stale") result["Head"] = new string('d', 40);
if (mode == "wrong_policy") result["PolicyBase"] = new string('d', 40);
if (mode == "advanced") { result["PolicyBase"] = input["base"]!.DeepClone(); result["Base"] = new string('d', 40); }
if (mode == "bad_digest") result["ReportDigest"] = new string('0', 64);
if (mode == "leak") result["Leak"] = input["authority_key"]!.DeepClone();
if (mode == "mutate") File.AppendAllText(Path.Combine(AppContext.BaseDirectory, "integrity.txt"), "changed");
Console.WriteLine(result.ToJsonString());
return status == "ready" ? 0 : 1;
