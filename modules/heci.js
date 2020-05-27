/*
Copyright 2020 Intel Corporation

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

var GM = null;
var setup = null;
var kernel32 = null;
var duplex = require('stream').Duplex;


if (process.platform == 'win32')
{
    GM = require('_GenericMarshal');
    setup = GM.CreateNativeProxy('SetupAPI.dll');
    setup.CreateMethod('SetupDiGetClassDevsA');
    setup.CreateMethod('SetupDiEnumDeviceInterfaces');
    setup.CreateMethod('SetupDiGetDeviceInterfaceDetailA');
    setup.CreateMethod('SetupDiDestroyDeviceInfoList');

    kernel32 = GM.CreateNativeProxy('Kernel32.dll');
    kernel32.CreateMethod('CloseHandle');
    kernel32.CreateMethod('CreateEventA');
    kernel32.CreateMethod('CreateFileA');
    kernel32.CreateMethod('DeviceIoControl');
    kernel32.CreateMethod('GetOverlappedResult');
    kernel32.CreateMethod('ReadFile');
    kernel32.CreateMethod('WriteFile');
}

var DIGCF_DEFAULT               = 0x00000001;  
var DIGCF_PRESENT               = 0x00000002;
var DIGCF_ALLCLASSES            = 0x00000004;
var DIGCF_PROFILE               = 0x00000008;
var DIGCF_DEVICEINTERFACE       = 0x00000010;
var ERROR_INSUFFICIENT_BUFFER   = 122;    
var GENERIC_READ                = 0x80000000;
var GENERIC_WRITE               = 0x40000000;
var FILE_SHARE_READ             = 0x00000001;  
var FILE_SHARE_WRITE            = 0x00000002;  
var OPEN_EXISTING               = 3;
var FILE_FLAG_OVERLAPPED        = 0x40000000;
var ERROR_IO_PENDING            = 997;

function heci_create()
{
    var ret = new duplex(
    {
        'write': function (chunk, flush)
        {
            console.log('write:' + chunk.length + ' on ' + this._hashCode());
            if (this._writeoverlapped == null) { throw ('Not Connected'); }
            if (chunk.length > this.MaxBufferSize) { throw ('Buffer too large'); }
            this._pendingWrites.unshift({ buffer: chunk, flush: flush });
            if (this._pendingWrites.length == 1)
            {
                // Kickstart the write
                this._processWrite();
            }

            return (false);
        },
        'final': function (flush)
        {
            flush();
        },
        'read': function(size)
        {
            console.log('read: (' + size + ') on ' + this._hashCode());
            if (!this._readbuffer) { this._readbuffer = GM.CreateVariable(this.MaxBufferSize); }

            var result = kernel32.ReadFile(this._descriptor, this._readbuffer, this._readbuffer._size, 0, this._readoverlapped);
            if(result.Val != 0 || result._LastError == ERROR_IO_PENDING)
            {
                if(!this._rDescriptorEvent)
                {
                    this._rDescriptorEvent = require('DescriptorEvents').addDescriptor(this._readoverlapped.hEvent, { metadata: 'heci.session [read]' });
                    this._rDescriptorEvent.session = this;
                    this._rDescriptorEvent.on('signaled', function (status)
                    {
                        console.log('Read Status: ' + status + ' on ' + this.session._hashCode());
                        if(status != 'NONE')
                        {
                            console.log('****** ' + status + '******');
                            this.session.push(null);
                            return;
                        }
                        var bytesRead = GM.CreateVariable(4);
                        var result;
                        if((result=kernel32.GetOverlappedResult(this.session._descriptor, this.session._readoverlapped, bytesRead, 0)).Val != 0)
                        {
                            var buffer = this.session._readbuffer.toBuffer().slice(0, bytesRead.toBuffer().readUInt32LE());
                            console.log(buffer.length + ' bytes READ');

                            var pushResult = this.session.push(buffer);
                            if (this.session._options.noPipeline != 0 && this.session._pendingWrites.length>0)
                            {
                                // Unlock a write
                                console.log('pendingWriteCount: ' + this.session._pendingWrites.length);
                                var item = this.session._pendingWrites.pop();
                                console.log('pendingWriteCount is now: ' + this.session._pendingWrites.length);

                                if (this.session._pendingWrites.length > 0)
                                {
                                    this.session._processWrite();
                                }
                                else
                                {
                                    console.log('Write/Flush');
                                    item.flush();
                                }
                            }

                            if (pushResult)
                            {
                                // We can read more, because data is still flowing
                                console.log('READING MORE on ' + this.session._hashCode());
                                var result = kernel32.ReadFile(this.session._descriptor, this.session._readbuffer, this.session._readbuffer._size, 0, this.session._readoverlapped);
                                if(result.Val != 0 || result._LastError == ERROR_IO_PENDING)
                                {
                                    return (true);
                                }
                                else
                                {
                                    console.log('Sometype of error: ' + result._LastError);
                                    this.session.push(null);
                                }
                            }
                        }
                        else
                        {
                            console.log('READ_OVERLAPPED_ERROR: ' + result._LastError + ' on ' + this.session._hashCode());
                        }

                    });
                }
            }
            else
            {
                console.log('Some Other Error: ' + result._LastError);
            }
        }
    });
    ret._ObjectID = 'heci.session';
    ret.bufferMode = 1;
    ret._ioctls = [];
    ret._pendingWrites = [];
    ret.heciParent = this;

    require('events').EventEmitter.call(ret, true)
        .createEvent('connect')
        .createEvent('error')
        .addMethod('connect', function _connect(guid, options)
        {
            console.log('connect()');
            this.doIoctl(this.heciParent.IOCTL.CLIENT_CONNECT, guid, Buffer.alloc(16), function _onconnect(status, buffer, opt)
            {
                if(status!=0)
                {
                    console.log('HECI Connection Error [' + this.LastError + ']');
                    this.emit('error', 'HECI Connection Error [' + this.LastError + ']');
                    return;
                }
                if(buffer.length <=4)
                {
                    // Invalid Response
                    this.emit('error', 'HECI Connection Error [INVALID RESPONSE]');
                    return;
                }
                Object.defineProperty(this, "MaxBufferSize", { value: buffer.readUInt32LE() });
                this._options = opt;
                this._readoverlapped = GM.CreateVariable(GM.PointerSize == 8 ? 32 : 20);
                this._writeoverlapped = GM.CreateVariable(GM.PointerSize == 8 ? 32 : 20);
                this._readoverlapped.hEvent = kernel32.CreateEventA(0, 1, 0, 0);
                this._writeoverlapped.hEvent = kernel32.CreateEventA(0, 1, 0, 0);
                this._readoverlapped.hEvent.pointerBuffer().copy(this._readoverlapped.Deref(GM.PointerSize == 8 ? 24 : 16, GM.PointerSize).toBuffer());
                this._writeoverlapped.hEvent.pointerBuffer().copy(this._writeoverlapped.Deref(GM.PointerSize == 8 ? 24 : 16, GM.PointerSize).toBuffer());
                
                console.log('Connected, buffer size: ' + this.MaxBufferSize);
                this._read(this.MaxBufferSize);
                this.emit('connect');
            }, options);
        })
        .addMethod('descriptorPath', function _descriptorPath()
        {
            console.log(' heci.createDescriptor()');

            var result;
            var ii;
            var deviceDetail;
            var bufferSize = GM.CreateVariable(4);  // DWORD
            var heciguid = GM.CreateVariable(this.heciParent.GUIDS.HECI);
            var deviceInfo = setup.SetupDiGetClassDevsA(heciguid, 0, 0, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
            if (deviceInfo.Val == -1)
            {
                console.log('... Unable to acquire [deviceInfo]');
                throw ('unable to acquire [deviceInfo]');
            }
            console.log('... acquired [deviceInfo]');


            var interfaceData = GM.CreateVariable(GM.PointerSize == 8 ? 32 : 28);
            interfaceData.toBuffer().writeUInt32LE(interfaceData._size, 0);

            for (ii = 0; setup.SetupDiEnumDeviceInterfaces(deviceInfo, 0, heciguid, ii, interfaceData).Val != 0; ++ii)
            {
                // Found our device instance
                if ((result = setup.SetupDiGetDeviceInterfaceDetailA(deviceInfo, interfaceData, 0, 0, bufferSize, 0)).Val == 0)
                {
                    if (result._LastError != ERROR_INSUFFICIENT_BUFFER)
                    {
                        continue;
                    }
                }

                // Allocate a big enough buffer to get detail data
                deviceDetail = GM.CreateVariable(bufferSize.toBuffer().readUInt32LE());
                deviceDetail.toBuffer().writeUInt32LE(GM.PointerSize == 8 ? 8 : 5, 0);

                // Try again to get the device interface detail info
                if (setup.SetupDiGetDeviceInterfaceDetailA(deviceInfo, interfaceData, deviceDetail, bufferSize, 0, 0).Val == 0)
                {
                    deviceDetail = NULL;
                    continue;
                }
                break;
            }
            setup.SetupDiDestroyDeviceInfoList(deviceInfo);
            if (deviceDetail == null)
            {
                console.log('... failed to acquire [deviceDetail]');
                throw ('unable to acquire [deviceDetail]');
            }

            var devPath = deviceDetail.Deref(4, GM.PointerSize);
            return (devPath.String);
        })
        .addMethod('createDescriptor', function _createDescriptor(path)
        {
            var devPath = GM.CreateVariable(path);
            var ret = kernel32.CreateFileA(devPath, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, 0, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, 0);
            if (ret.Val == -1)
            {
                console.log('... failed to acquire [descriptor]');
                throw ('failed to acquire descriptor');
            }
            console.log('... acquired [DESCRIPTOR]');
            return (ret);
        });
    if (process.platform == 'win32')
    {
        ret._overlapped = GM.CreateVariable(GM.PointerSize == 8 ? 32 : 20);
        ret._overlapped.hEvent = kernel32.CreateEventA(0, 1, 0, 0);

        var overlapped_eventptr = ret._overlapped.Deref(GM.PointerSize == 8 ? 24 : 16, GM.PointerSize).toBuffer();
        ret._overlapped.hEvent.pointerBuffer().copy(overlapped_eventptr);
    }
    ret.disconnect = function disconnect()
    {
        // Clean up all Handles and Descriptors
        console.log('DISCONNECT on ' + this._hashCode());


        //
        // doIoctl() 
        //
        if (this._descriptorEvent)
        {
            if (this._overlapped) { require('DescriptorEvents').removeDescriptor(this._overlapped.hEvent); }
            this._descriptorEvent = null;
        }
        if (this._overlapped)
        {
            kernel32.CloseHandle(this._overlapped.hEvent);
            this._overlapped = null;
        }

        //
        // Read
        //
        if (this._rDescriptorEvent)
        {
            if (this._readoverlapped) { require('DescriptorEvents').removeDescriptor(this._readoverlapped.hEvent); }
            this._rDescriptorEvent = null;
        }
        if (this._readoverlapped)
        {
            kernel32.CloseHandle(this._readoverlapped.hEvent);
            this._readoverlapped = null;
        }

        //
        // Write
        //
        if (this._wDescriptorEvent)
        {
            if (this._writeoverlapped) { require('DescriptorEvents').removeDescriptor(this._writeoverlapped.hEvent); }
            this._wDescriptorEvent = null;
        }
        if (this._writeoverlapped)
        {
            kernel32.CloseHandle(this._writeoverlapped.hEvent);
            this._writeoverlapped = null;
        }

        //
        // HECI
        //
        if (this._descriptor)
        {
            kernel32.CloseHandle(this._descriptor);
            this._descriptor = null;
        }

    };
    ret.doIoctl = function doIoctl(code, inputBuffer, outputBuffer, callback)
    {
        console.log('doIoctl()');
        if(typeof(callback)!='function') { throw('Callback not specified');}
        var i;
        var parms = [];
        for (i = 4; i < arguments.length; ++i)
        {
            parms.push(arguments[i]);
        }

        this._ioctls.unshift({ code: code, input: inputBuffer, output: outputBuffer, callback: callback, parms: parms });
        if(this._ioctls.length == 1)
        {
            // First IOCTL, so we need to send the first one
            this._send(this._ioctls.peek());
        }
    };
    ret._send = function _send(options)
    {
        if(this._descriptor == null) 
        {
            this._descriptor = this.createDescriptor(this.descriptorPath()); 
            this._descriptorEvent = require('DescriptorEvents').addDescriptor(this._overlapped.hEvent, {metadata: 'heci'});
            this._descriptorEvent.session = this;
            this._descriptorEvent.on('signaled', function(status)
            {
                var data = this.session._ioctls.pop();
                if(status == 'NONE')
                {
                    var bytesRead = GM.CreateVariable(4);
                    var result = kernel32.GetOverlappedResult(this.session._descriptor, this.session._overlapped, bytesRead, 0);
                    if(result.Val != 0)
                    {
                        var out = data.output;
                        try
                        {
                            out.slice(0,bytesRead.toBuffer().readUInt32LE());
                        }
                        catch(e)
                        {
                            out = null;
                        }
                        data.parms.unshift(out);
                        data.parms.unshift(0);
                        this.session.LastError = 'NONE';
                    }
                    else
                    {
                        data.parms.unshift(null);
                        data.parms.unshift(1);
                        this.session.LastError = 'OVERLAPPED_ERROR: ' + result._LastError;
                    }
                }
                else
                {
                    data.parms.unshift(null);
                    data.parms.unshift(1);
                    this.session.LastError = status;
                }
                try
                {
                    data.callback.apply(this.session, data.parms);
                }
                catch(ue)
                {
                    process.emit('uncaughtException', ue);
                }
                if(this.session._ioctls.length > 0)
                {
                    // Still more IOCTLs to send
                    this.session._send(this.session._ioctls.peek());
                    return (true);
                }
            });
        }
        kernel32.DeviceIoControl(this._descriptor, options.code, GM.CreateVariable(options.input), options.input.length, GM.CreateVariable(options.output), options.output.length, 0, this._overlapped);
    };
    ret._processWrite = function _processWrite()
    {
        var chunk = this._pendingWrites.peek();
        console.log('_WRITING: ' + chunk.buffer.length + ' bytes' + ' on ' + this._hashCode());
        if (chunk.buffer.length == 23)
        {
            console.log(chunk.buffer.toString('hex'));
            GM.CreateVariable(chunk.buffer)._debug();
        }
        var result = kernel32.WriteFile(this._descriptor, GM.CreateVariable(chunk.buffer), chunk.buffer.length, 0, this._writeoverlapped);
        if(result.Val != 0 || result._LastError == ERROR_IO_PENDING)
        {
            if(!this._wDescriptorEvent)
            {
                this._wDescriptorEvent = require('DescriptorEvents').addDescriptor(this._writeoverlapped.hEvent, { metadata: 'heci.session [write]' });
                this._wDescriptorEvent.session = this;
                this._wDescriptorEvent.on('signaled', this._processWrite_signaled);
            }
        }
        else
        {
            console.log('Write Error: ' + result._LastError);
        }
    };
    ret._processWrite_signaled = function _processWrite_signaled(status)
    {
        console.log('Write Signaled: ' + status);
        if(status == 'NONE')
        {
            // No Errors
            var bytesWritten = GM.CreateVariable(4);
            var result = kernel32.GetOverlappedResult(this.session._descriptor, this.session._writeoverlapped, bytesWritten, 0);
            if(result.Val != 0)
            {
                console.log(bytesWritten.toBuffer().readUInt32LE() + ' bytes written');
                console.log('noPipeline = ' + this.session._options.noPipeline, this.session._pendingWrites.length);
                if(this.session._options.noPipeline==null || this.session._options.noPipeline == false)
                {
                    var item = this.session._pendingWrites.pop();
                    if (this.session._pendingWrites.length > 0)
                    {
                        this.session._processWrite();
                    }
                    else
                    {
                        console.log('Write/Flush');
                        item.flush();
                    }
                    return (true);
                }
            }
        }
    };
    return (ret);
}

var ioctl = {};
Object.defineProperty(ioctl, 'HECI_VERSION', { value: 0x8000E000 });
Object.defineProperty(ioctl, 'CLIENT_CONNECT', { value: 0x8000E004 });
var guids = {};
Object.defineProperty(guids, 'AMT', { value: Buffer.from('2800F812B7B42D4BACA846E0FF65814C', 'hex') });
Object.defineProperty(guids, 'LME', { value: Buffer.from('DBA4336776047B4EB3AFBCFC29BEE7A7', 'hex') });
if (process.platform == 'win32')
{
    Object.defineProperty(guids, 'HECI', { value: Buffer.from('34FFD1E25834A94988DA8E6915CE9BE5', 'hex') });
}


module.exports = { _ObjectID: 'heci', IOCTL: ioctl, GUIDS: guids, create: heci_create };
Object.defineProperty(module.exports, "supported", {
    get: function ()
    {
        try
        {
            var p = this.create().descriptorPath();
            console.log(p);
            var d = this.create().createDescriptor(p);
            console.log(d.Val);
            return(true);
        }
        catch(e)
        {
            console.log(e);
            return (false);
        }
    }
});