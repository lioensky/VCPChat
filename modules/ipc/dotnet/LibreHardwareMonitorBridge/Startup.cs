using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;

namespace VCPChat.LibreHardwareMonitorBridge
{
    public sealed class Startup
    {
        private static readonly object SyncRoot = new object();

        private static ResolveEventHandler CurrentResolver;
        private static string CurrentDllPath;
        private static string CurrentAssemblyDirectory;
        private static Assembly CurrentLibreAssembly;
        private static object CurrentComputer;
        private static bool CurrentComputerOpened;
        private static bool CurrentIncludeControllers;

        public Task<object> Invoke(object input)
        {
            return Task.Factory.StartNew<object>(delegate
            {
                var temperatures = new List<object>();
                var fans = new List<object>();
                var voltages = new List<object>();
                var powers = new List<object>();

                lock (SyncRoot)
                {
                    var dllPath = GetInputString(input, "dllPath");
                    if (string.IsNullOrWhiteSpace(dllPath) || !File.Exists(dllPath))
                    {
                        throw new FileNotFoundException("未找到 LibreHardwareMonitorLib.dll", dllPath);
                    }

                    var includeControllers = GetInputBool(input, "includeControllers", false);
                    EnsureComputer(dllPath, includeControllers);

                    foreach (var hardware in Enumerate(GetProperty(CurrentComputer, "Hardware")))
                    {
                        CollectHardware(hardware, temperatures, fans, voltages, powers);
                    }
                }

                return (object)new Dictionary<string, object>
                {
                    { "temperatures", temperatures },
                    { "fans", fans },
                    { "voltages", voltages },
                    { "powers", powers },
                    { "source", "LibreHardwareMonitorLib" },
                };
            });
        }

        private static void EnsureComputer(string dllPath, bool includeControllers)
        {
            if (CurrentComputer != null
                && CurrentComputerOpened
                && StringEqualsPath(CurrentDllPath, dllPath)
                && CurrentIncludeControllers == includeControllers)
            {
                return;
            }

            ResetComputer();

            CurrentDllPath = dllPath;
            CurrentIncludeControllers = includeControllers;
            CurrentAssemblyDirectory = Path.GetDirectoryName(dllPath);

            CurrentResolver = delegate(object sender, ResolveEventArgs args)
            {
                return ResolveAssembly(args, CurrentAssemblyDirectory);
            };
            AppDomain.CurrentDomain.AssemblyResolve += CurrentResolver;

            CurrentLibreAssembly = Assembly.LoadFrom(dllPath);
            var computerType = CurrentLibreAssembly.GetType("LibreHardwareMonitor.Hardware.Computer", true);
            CurrentComputer = Activator.CreateInstance(computerType);
            if (CurrentComputer == null)
            {
                throw new InvalidOperationException("无法创建 LibreHardwareMonitor.Hardware.Computer 实例");
            }

            // 默认只打开 CPU/GPU/内存/主板传感器，控制器链路（如 USB HID）可选开启。
            SetBooleanProperty(CurrentComputer, "IsCpuEnabled", true);
            SetBooleanProperty(CurrentComputer, "IsGpuEnabled", true);
            SetBooleanProperty(CurrentComputer, "IsMemoryEnabled", true);
            SetBooleanProperty(CurrentComputer, "IsMotherboardEnabled", true);
            SetBooleanProperty(CurrentComputer, "IsControllerEnabled", includeControllers);
            SetBooleanProperty(CurrentComputer, "IsNetworkEnabled", false);
            SetBooleanProperty(CurrentComputer, "IsStorageEnabled", false);

            try
            {
                InvokeVoid(CurrentComputer, "Open");
                CurrentComputerOpened = true;
            }
            catch
            {
                ResetComputer();
                throw;
            }
        }

        private static void ResetComputer()
        {
            if (CurrentComputer != null)
            {
                SafeInvoke(CurrentComputer, "Close");

                var disposable = CurrentComputer as IDisposable;
                if (disposable != null)
                {
                    try { disposable.Dispose(); } catch { }
                }
            }

            if (CurrentResolver != null)
            {
                try { AppDomain.CurrentDomain.AssemblyResolve -= CurrentResolver; } catch { }
            }

            CurrentResolver = null;
            CurrentDllPath = null;
            CurrentAssemblyDirectory = null;
            CurrentLibreAssembly = null;
            CurrentComputer = null;
            CurrentComputerOpened = false;
            CurrentIncludeControllers = false;
        }

        private static void CollectHardware(
            object hardware,
            List<object> temperatures,
            List<object> fans,
            List<object> voltages,
            List<object> powers)
        {
            SafeInvoke(hardware, "Update");

            foreach (var sensor in Enumerate(GetProperty(hardware, "Sensors")))
            {
                AppendSensor(hardware, sensor, temperatures, fans, voltages, powers);
            }

            foreach (var subHardware in Enumerate(GetProperty(hardware, "SubHardware")))
            {
                CollectHardware(subHardware, temperatures, fans, voltages, powers);
            }
        }

        private static void AppendSensor(
            object hardware,
            object sensor,
            List<object> temperatures,
            List<object> fans,
            List<object> voltages,
            List<object> powers)
        {
            var sensorValue = ToNullableDouble(GetProperty(sensor, "Value"));
            if (!sensorValue.HasValue)
            {
                return;
            }

            var item = new Dictionary<string, object>
            {
                { "name", (GetProperty(sensor, "Name") ?? GetProperty(sensor, "Identifier") ?? string.Empty).ToString() },
                { "identifier", ToStringOrNull(GetProperty(sensor, "Identifier")) },
                { "hardware", ToStringOrNull(GetProperty(hardware, "Name")) },
                { "hardwareType", ToStringOrNull(GetProperty(hardware, "HardwareType")) },
                { "source", "LibreHardwareMonitorLib" },
            };

            switch ((ToStringOrNull(GetProperty(sensor, "SensorType")) ?? string.Empty).ToLowerInvariant())
            {
                case "temperature":
                    item["valueC"] = sensorValue.Value;
                    temperatures.Add(item);
                    break;
                case "fan":
                    item["rpm"] = sensorValue.Value;
                    fans.Add(item);
                    break;
                case "voltage":
                    item["volts"] = sensorValue.Value;
                    voltages.Add(item);
                    break;
                case "power":
                    item["watts"] = sensorValue.Value;
                    powers.Add(item);
                    break;
            }
        }

        private static Assembly ResolveAssembly(ResolveEventArgs args, string assemblyDirectory)
        {
            if (string.IsNullOrWhiteSpace(assemblyDirectory))
            {
                return null;
            }

            var assemblyName = new AssemblyName(args.Name).Name;
            if (string.IsNullOrWhiteSpace(assemblyName))
            {
                return null;
            }

            var candidate = Path.Combine(assemblyDirectory, assemblyName + ".dll");
            return File.Exists(candidate) ? Assembly.LoadFrom(candidate) : null;
        }

        private static string GetInputString(object input, string propertyName)
        {
            if (input == null)
            {
                return null;
            }

            var dictionary = input as IDictionary<string, object>;
            object value;
            if (dictionary != null && dictionary.TryGetValue(propertyName, out value))
            {
                return ToStringOrNull(value);
            }

            var property = input.GetType().GetProperty(propertyName, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            return property == null ? null : ToStringOrNull(SafeGetValue(property, input));
        }

        private static bool GetInputBool(object input, string propertyName, bool defaultValue)
        {
            if (input == null)
            {
                return defaultValue;
            }

            var dictionary = input as IDictionary<string, object>;
            object value;
            if (dictionary != null && dictionary.TryGetValue(propertyName, out value))
            {
                return ToBoolOrDefault(value, defaultValue);
            }

            var property = input.GetType().GetProperty(propertyName, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            return property == null ? defaultValue : ToBoolOrDefault(SafeGetValue(property, input), defaultValue);
        }

        private static object GetProperty(object target, string propertyName)
        {
            if (target == null)
            {
                return null;
            }

            var property = target.GetType().GetProperty(propertyName, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            if (property == null)
            {
                return null;
            }

            return SafeGetValue(property, target);
        }

        private static object SafeGetValue(PropertyInfo property, object target)
        {
            try
            {
                return property.GetValue(target, null);
            }
            catch
            {
                return null;
            }
        }

        private static void SetBooleanProperty(object target, string propertyName, bool value)
        {
            var property = target.GetType().GetProperty(propertyName, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            if (property != null && property.CanWrite)
            {
                try { property.SetValue(target, value, null); } catch { }
            }
        }

        private static void InvokeVoid(object target, string methodName)
        {
            var method = target.GetType().GetMethod(methodName, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            if (method == null)
            {
                throw new MissingMethodException(target.GetType().FullName, methodName);
            }

            try
            {
                method.Invoke(target, null);
            }
            catch (TargetInvocationException ex)
            {
                throw ex.InnerException ?? ex;
            }
        }

        private static void SafeInvoke(object target, string methodName)
        {
            var method = target.GetType().GetMethod(methodName, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            if (method != null)
            {
                try { method.Invoke(target, null); } catch { }
            }
        }

        private static IEnumerable<object> Enumerate(object value)
        {
            var enumerable = value as IEnumerable;
            if (enumerable == null)
            {
                yield break;
            }

            foreach (var item in enumerable)
            {
                if (item != null)
                {
                    yield return item;
                }
            }
        }

        private static double? ToNullableDouble(object value)
        {
            if (value == null)
            {
                return null;
            }

            try
            {
                return Convert.ToDouble(value);
            }
            catch
            {
                return null;
            }
        }

        private static string ToStringOrNull(object value)
        {
            return value == null ? null : value.ToString();
        }

        private static bool ToBoolOrDefault(object value, bool defaultValue)
        {
            if (value == null)
            {
                return defaultValue;
            }

            if (value is bool)
            {
                return (bool)value;
            }

            try
            {
                return Convert.ToBoolean(value);
            }
            catch
            {
                return defaultValue;
            }
        }

        private static bool StringEqualsPath(string left, string right)
        {
            if (left == null || right == null)
            {
                return false;
            }

            return string.Equals(left.Trim(), right.Trim(), StringComparison.OrdinalIgnoreCase);
        }
    }
}
