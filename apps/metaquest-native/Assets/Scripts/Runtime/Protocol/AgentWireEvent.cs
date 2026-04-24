using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace XRCodingAgent.MetaQuestNative.Protocol
{
    [Serializable]
    public sealed class AgentWireEvent
    {
        [JsonProperty("type")]
        public string Type = string.Empty;

        [JsonProperty("ts")]
        public string Timestamp = string.Empty;

        [JsonProperty("session_id")]
        public string? SessionId;

        [JsonProperty("payload")]
        public Dictionary<string, JToken> Payload = new();

        [JsonIgnore]
        public string EventId => $"{Timestamp}-{Type}-{SessionId ?? "none"}";

        public string? GetString(string key)
        {
            if (!Payload.TryGetValue(key, out var token) || token.Type == JTokenType.Null)
            {
                return null;
            }

            return token.Type switch
            {
                JTokenType.String => token.Value<string>(),
                JTokenType.Integer => token.Value<long>().ToString(),
                JTokenType.Float => token.Value<double>().ToString("G"),
                JTokenType.Boolean => token.Value<bool>() ? "true" : "false",
                _ => token.ToString(Formatting.None),
            };
        }

        public int? GetInt(string key)
        {
            if (!Payload.TryGetValue(key, out var token))
            {
                return null;
            }

            if (token.Type == JTokenType.Integer)
            {
                return token.Value<int>();
            }

            return int.TryParse(GetString(key), out var parsed) ? parsed : null;
        }

        public bool? GetBool(string key)
        {
            if (!Payload.TryGetValue(key, out var token))
            {
                return null;
            }

            if (token.Type == JTokenType.Boolean)
            {
                return token.Value<bool>();
            }

            var text = GetString(key)?.Trim().ToLowerInvariant();
            return text switch
            {
                "true" => true,
                "1" => true,
                "yes" => true,
                "false" => false,
                "0" => false,
                "no" => false,
                _ => null,
            };
        }
    }
}
